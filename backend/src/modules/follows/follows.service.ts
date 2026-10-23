import type { Ctx } from '../../context.js';
import { badRequest, forbidden, isDuplicateKeyError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import type { UserBrief } from '../users/users.presenter.js';

/**
 * Follow graph. The edge insert and both counter updates happen in one transaction, so
 * `stats.followers` / `stats.following` never drift from the `follows` collection.
 */
export class FollowsService {
  constructor(private readonly ctx: Ctx) {}

  async follow(followerId: string, followeeId: string): Promise<{ followed: boolean }> {
    if (followerId === followeeId) throw badRequest('You cannot follow yourself');
    await this.ctx.services.users.get(followeeId);
    if (await this.ctx.services.users.isBlockedEitherWay(followerId, followeeId)) {
      throw forbidden('You cannot follow this user');
    }
    try {
      await this.ctx.db.withTransaction(async (session) => {
        await this.ctx.col.follows.insertOne(
          { followerId, followeeId, createdAt: this.ctx.clock.now() },
          { session },
        );
        await this.ctx.col.users.updateOne({ _id: followerId }, { $inc: { 'stats.following': 1 } }, { session });
        await this.ctx.col.users.updateOne({ _id: followeeId }, { $inc: { 'stats.followers': 1 } }, { session });
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) return { followed: false };
      throw err;
    }
    void this.ctx.services.notifications
      .notify(followeeId, { type: 'follow', title: 'New follower', body: 'Someone started following you', data: { userId: followerId } }, { push: false })
      .catch(() => undefined);
    return { followed: true };
  }

  async unfollow(followerId: string, followeeId: string): Promise<{ unfollowed: boolean }> {
    const removed = await this.ctx.db.withTransaction(async (session) => {
      const res = await this.ctx.col.follows.deleteOne({ followerId, followeeId }, { session });
      if (!res.deletedCount) return false;
      await this.ctx.col.users.updateOne({ _id: followerId }, { $inc: { 'stats.following': -1 } }, { session });
      await this.ctx.col.users.updateOne({ _id: followeeId }, { $inc: { 'stats.followers': -1 } }, { session });
      return true;
    });
    return { unfollowed: removed };
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return (await this.ctx.col.follows.countDocuments({ followerId, followeeId }, { limit: 1 })) > 0;
  }

  async list(uid: string, direction: 'followers' | 'following', cursor: string | undefined, limit: number) {
    const after = decodeCursor(cursor);
    const field = direction === 'followers' ? 'followeeId' : 'followerId';
    const other = direction === 'followers' ? 'followerId' : 'followeeId';
    const rows = await this.ctx.col.follows
      .find({
        [field]: uid,
        ...(after ? { createdAt: { $lt: after.date } } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const briefs = await this.ctx.services.users.briefs(page.map((r) => r[other]));
    const last = page.at(-1);
    return {
      items: page.map((r) => briefs.get(r[other])).filter((b): b is UserBrief => Boolean(b)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  /** All follower uids of a host (for go-live push fan-out). Streams to bound memory. */
  async *followerIds(uid: string): AsyncGenerator<string> {
    const cursor = this.ctx.col.follows.find({ followeeId: uid }, { projection: { followerId: 1 } });
    for await (const row of cursor) yield row.followerId;
  }

  async removeAllFor(uid: string): Promise<void> {
    const [outgoing, incoming] = await Promise.all([
      this.ctx.col.follows.find({ followerId: uid }, { projection: { followeeId: 1 } }).toArray(),
      this.ctx.col.follows.find({ followeeId: uid }, { projection: { followerId: 1 } }).toArray(),
    ]);
    if (outgoing.length) {
      await this.ctx.col.users.updateMany({ _id: { $in: outgoing.map((r) => r.followeeId) } }, { $inc: { 'stats.followers': -1 } });
    }
    if (incoming.length) {
      await this.ctx.col.users.updateMany({ _id: { $in: incoming.map((r) => r.followerId) } }, { $inc: { 'stats.following': -1 } });
    }
    await this.ctx.col.follows.deleteMany({ $or: [{ followerId: uid }, { followeeId: uid }] });
    await this.ctx.col.users.updateOne({ _id: uid }, { $set: { 'stats.followers': 0, 'stats.following': 0 } });
  }
}
