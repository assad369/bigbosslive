import { z } from 'zod';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { UserDoc } from '../../db/schema.js';
import type { VerifiedToken } from '../../infra/firebase.js';
import { badRequest, conflict, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { BRIEF_PROJECTION, toPublicUser, toUserBrief, type UserBrief } from './users.presenter.js';

export const profileInput = z.object({
  displayName: z.string().trim().min(2).max(30),
  avatarUrl: z.url().max(2048).nullable(),
  bio: z.string().trim().max(160),
  gender: z.enum(['male', 'female', 'other']).nullable(),
  birthday: z.coerce.date().nullable(),
  country: z.string().trim().length(2).toUpperCase().nullable(),
});
export type ProfileInput = z.infer<typeof profileInput>;

const FIRST_SHORT_ID = 10_000_000;

export class UsersService {
  constructor(private readonly ctx: Ctx) {}

  private get col() {
    return this.ctx.col.users;
  }

  async get(uid: string): Promise<UserDoc> {
    const user = await this.col.findOne({ _id: uid });
    if (!user || user.status === 'deleted') throw notFound('User');
    return user;
  }

  async briefs(uids: string[]): Promise<Map<string, UserBrief>> {
    const unique = [...new Set(uids)];
    if (!unique.length) return new Map();
    const docs = await this.col.find({ _id: { $in: unique } }, { projection: BRIEF_PROJECTION }).toArray();
    const now = this.ctx.clock.now();
    return new Map(docs.map((d) => [d._id, toUserBrief(d as UserDoc, now)]));
  }

  private async nextShortId(): Promise<string> {
    const res = await this.ctx.col.counters.findOneAndUpdate(
      { _id: 'user_short_id' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    return String(FIRST_SHORT_ID + (res?.seq ?? 1));
  }

  /**
   * Idempotent session bootstrap: creates the profile on first sign-in, otherwise refreshes
   * identity fields from the verified token. Safe to call on every app launch.
   */
  async ensureProfile(token: VerifiedToken, input: Partial<ProfileInput> = {}): Promise<{ user: UserDoc; created: boolean }> {
    const existing = await this.col.findOne({ _id: token.uid });
    const now = this.ctx.clock.now();
    if (existing) {
      if (existing.status === 'deleted') throw conflict('This account was deleted', 'account_deleted');
      const $set: Partial<UserDoc> = { lastSeenAt: now, adminRole: token.adminRole };
      if (token.email && token.email !== existing.email) $set.email = token.email;
      if (token.phone && token.phone !== existing.phone) $set.phone = token.phone;
      await this.col.updateOne({ _id: token.uid }, { $set });
      return { user: { ...existing, ...$set }, created: false };
    }

    const displayName = await this.ctx.services.moderation.cleanText(
      input.displayName ?? token.name ?? `Boss${Math.floor(Math.random() * 1e6)}`,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc: UserDoc = {
        _id: token.uid,
        shortId: await this.nextShortId(),
        displayName: displayName.slice(0, 30),
        displayNameLower: displayName.slice(0, 30).toLowerCase(),
        avatarUrl: input.avatarUrl ?? token.picture ?? null,
        bio: input.bio ?? '',
        gender: input.gender ?? null,
        birthday: input.birthday ?? null,
        country: input.country ?? null,
        email: token.email,
        phone: token.phone,
        status: 'active',
        ban: null,
        adminRole: token.adminRole,
        isAgent: false,
        wallet: { diamonds: 0, beans: 0, agentStock: 0 },
        stats: { followers: 0, following: 0, totalRecharged: 0, totalReceived: 0, totalSent: 0, liveSeconds: 0 },
        level: { level: 0, points: 0 },
        vip: { tier: 0, expiresAt: null },
        equipped: { frameId: null, entryAnimationId: null, frameUrl: null },
        agencyId: null,
        liveRoomId: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        deletedAt: null,
      };
      try {
        await this.col.insertOne(doc);
        await this.ctx.services.levels.recalculate(doc._id);
        return { user: doc, created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Lost a race with a concurrent first launch: the other request created the profile.
        const raced = await this.col.findOne({ _id: token.uid });
        if (raced) return { user: raced, created: false };
        // Otherwise a shortId collision (manually assigned id) — retry with the next sequence.
      }
    }
    throw conflict('Could not allocate a user id, retry');
  }

  async updateProfile(uid: string, patch: Partial<ProfileInput>): Promise<UserDoc> {
    const $set: Partial<UserDoc> = { updatedAt: this.ctx.clock.now() };
    if (patch.displayName !== undefined) {
      const name = await this.ctx.services.moderation.assertClean(patch.displayName, 'displayName');
      $set.displayName = name;
      $set.displayNameLower = name.toLowerCase();
    }
    if (patch.bio !== undefined) $set.bio = await this.ctx.services.moderation.assertClean(patch.bio, 'bio');
    if (patch.avatarUrl !== undefined) $set.avatarUrl = patch.avatarUrl;
    if (patch.gender !== undefined) $set.gender = patch.gender;
    if (patch.birthday !== undefined) $set.birthday = patch.birthday;
    if (patch.country !== undefined) $set.country = patch.country;
    const updated = await this.col.findOneAndUpdate({ _id: uid, status: { $ne: 'deleted' } }, { $set }, { returnDocument: 'after' });
    if (!updated) throw notFound('User');
    return updated;
  }

  async publicProfile(uid: string, viewerUid: string | null) {
    const user = await this.get(uid);
    const [isFollowing, isBlocked] = viewerUid && viewerUid !== uid
      ? await Promise.all([
          this.ctx.col.follows.countDocuments({ followerId: viewerUid, followeeId: uid }, { limit: 1 }),
          this.ctx.col.blocks.countDocuments({ blockerId: viewerUid, blockedId: uid }, { limit: 1 }),
        ])
      : [0, 0];
    return { ...toPublicUser(user, this.ctx.clock.now()), isFollowing: isFollowing > 0, isBlocked: isBlocked > 0 };
  }

  /** Search by exact short id or display-name prefix. */
  async search(q: string, limit: number): Promise<UserBrief[]> {
    const term = q.trim();
    if (!term) return [];
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter: Filter<UserDoc> = /^\d{5,12}$/.test(term)
      ? { status: 'active', $or: [{ shortId: term }, { displayNameLower: { $regex: `^${escaped}` } }] }
      : { status: 'active', displayNameLower: { $regex: `^${escaped}` } };
    const docs = await this.col.find(filter, { projection: BRIEF_PROJECTION }).sort({ 'level.level': -1 }).limit(limit).toArray();
    const now = this.ctx.clock.now();
    return docs.map((d) => toUserBrief(d as UserDoc, now));
  }

  async block(uid: string, target: string): Promise<void> {
    if (uid === target) throw badRequest('You cannot block yourself');
    await this.get(target);
    await this.ctx.col.blocks.updateOne(
      { blockerId: uid, blockedId: target },
      { $setOnInsert: { blockerId: uid, blockedId: target, createdAt: this.ctx.clock.now() } },
      { upsert: true },
    );
    // Blocking also removes follow edges in both directions.
    await Promise.all([
      this.ctx.services.follows.unfollow(uid, target).catch(() => undefined),
      this.ctx.services.follows.unfollow(target, uid).catch(() => undefined),
    ]);
  }

  async unblock(uid: string, target: string): Promise<void> {
    await this.ctx.col.blocks.deleteOne({ blockerId: uid, blockedId: target });
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const n = await this.ctx.col.blocks.countDocuments(
      { $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
      { limit: 1 },
    );
    return n > 0;
  }

  async blockedList(uid: string): Promise<UserBrief[]> {
    const rows = await this.ctx.col.blocks.find({ blockerId: uid }).sort({ createdAt: -1 }).limit(500).toArray();
    const briefs = await this.briefs(rows.map((r) => r.blockedId));
    return rows.map((r) => briefs.get(r.blockedId)).filter((b): b is UserBrief => Boolean(b));
  }

  async touch(uid: string, deviceId: string | null, platform: string | null): Promise<void> {
    const now = this.ctx.clock.now();
    await this.col.updateOne({ _id: uid }, { $set: { lastSeenAt: now } });
    if (deviceId) {
      await this.ctx.col.devices.updateOne(
        { userId: uid, deviceId },
        { $set: { lastSeenAt: now, platform }, $setOnInsert: { userId: uid, deviceId, firstSeenAt: now } },
        { upsert: true },
      );
    }
  }

  async liftExpiredBan(uid: string): Promise<void> {
    await this.col.updateOne(
      { _id: uid, status: 'banned', 'ban.until': { $lte: this.ctx.clock.now() } },
      { $set: { status: 'active', ban: null } },
    );
  }

  async ban(uid: string, opts: { reason: string; until: Date | null; by: string }): Promise<void> {
    const now = this.ctx.clock.now();
    const res = await this.col.updateOne(
      { _id: uid, status: { $ne: 'deleted' } },
      { $set: { status: 'banned', ban: { reason: opts.reason, until: opts.until, by: opts.by, at: now }, updatedAt: now } },
    );
    if (!res.matchedCount) throw notFound('User');
    await this.ctx.auth.revokeSessions(uid).catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'revoke failed'));
    await this.ctx.services.live.endActiveRoomFor(uid, 'banned', opts.by);
  }

  async unban(uid: string): Promise<void> {
    const res = await this.col.updateOne({ _id: uid, status: 'banned' }, { $set: { status: 'active', ban: null, updatedAt: this.ctx.clock.now() } });
    if (!res.matchedCount) throw notFound('Banned user');
  }

  /** Admin: give a user a specific (e.g. vanity) short id, or swap ids between two users. */
  async setShortId(uid: string, shortId: string): Promise<void> {
    if (!/^\d{4,12}$/.test(shortId)) throw badRequest('Short id must be 4–12 digits');
    const holder = await this.col.findOne({ shortId }, { projection: { _id: 1 } });
    if (holder && holder._id !== uid) {
      // Swap inside a transaction so neither user is ever left without an id.
      const target = await this.get(uid);
      await this.ctx.db.withTransaction(async (session) => {
        await this.col.updateOne({ _id: holder._id }, { $set: { shortId: `tmp-${holder._id}` } }, { session });
        await this.col.updateOne({ _id: uid }, { $set: { shortId } }, { session });
        await this.col.updateOne({ _id: holder._id }, { $set: { shortId: target.shortId } }, { session });
      });
      return;
    }
    try {
      const res = await this.col.updateOne({ _id: uid }, { $set: { shortId } });
      if (!res.matchedCount) throw notFound('User');
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('Short id is taken');
      throw err;
    }
  }

  /**
   * Account deletion (store-policy requirement). Profile data is anonymised, balances are kept
   * for the financial ledger, follow edges and push tokens are removed, and the Firebase user
   * is deleted so the identity cannot sign back in.
   */
  async deleteAccount(uid: string): Promise<void> {
    const now = this.ctx.clock.now();
    await this.ctx.services.live.endActiveRoomFor(uid, 'host', uid);
    const res = await this.col.updateOne(
      { _id: uid, status: { $ne: 'deleted' } },
      {
        $set: {
          status: 'deleted',
          deletedAt: now,
          displayName: 'Deleted user',
          displayNameLower: 'deleted user',
          avatarUrl: null,
          bio: '',
          email: null,
          phone: null,
          birthday: null,
          updatedAt: now,
        },
      },
    );
    if (!res.matchedCount) throw notFound('User');
    await Promise.all([
      this.ctx.services.follows.removeAllFor(uid),
      this.ctx.col.pushTokens.deleteMany({ userId: uid }),
      this.ctx.services.agencies.removeMember(uid).catch(() => undefined),
    ]);
    await this.ctx.auth.deleteUser(uid).catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'firebase delete failed'));
  }
}
