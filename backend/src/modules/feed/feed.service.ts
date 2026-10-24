import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import type { FeedPostDoc } from '../../db/schema.js';
import { forbidden, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';
import type { UserBrief } from '../users/users.presenter.js';

export const createPostInput = z
  .object({
    text: z.string().trim().max(2000).default(''),
    media: z
      .array(
        z.object({
          url: z.url(),
          type: z.enum(['image', 'video']),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
        }),
      )
      .max(9)
      .default([]),
  })
  .refine((p) => p.text.length > 0 || p.media.length > 0, 'A post needs text or media');

export const commentInput = z.object({ text: z.string().trim().min(1).max(500) });

/** Hacker-News-style gravity: engagement decays with age so fresh posts can trend. */
export function trendingScore(likes: number, comments: number, createdAt: Date, now: Date): number {
  const hours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  return (likes + 2 * comments + 1) / Math.pow(hours + 2, 1.5);
}

const TRENDING_WINDOW_DAYS = 7;

export class FeedService {
  constructor(private readonly ctx: Ctx) {}

  private async assertEnabled(): Promise<void> {
    if (!(await this.ctx.services.config.get('features')).feedEnabled)
      throw forbidden('The feed is currently disabled');
  }

  private async hydrate(posts: FeedPostDoc[], viewerUid: string) {
    const [briefs, liked] = await Promise.all([
      this.ctx.services.users.briefs(posts.map((p) => p.authorId)),
      this.ctx.col.feedLikes
        .find(
          { userId: viewerUid, postId: { $in: posts.map((p) => p._id) } },
          { projection: { postId: 1 } },
        )
        .toArray(),
    ]);
    const likedSet = new Set(liked.map((l) => String(l.postId)));
    return posts.map((p) => ({
      id: String(p._id),
      author: briefs.get(p.authorId) ?? null,
      text: p.text,
      media: p.media,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      likedByMe: likedSet.has(String(p._id)),
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async create(uid: string, input: z.infer<typeof createPostInput>) {
    await this.assertEnabled();
    const text = input.text
      ? await this.ctx.services.moderation.assertClean(input.text, 'post')
      : '';
    const now = this.ctx.clock.now();
    const doc: FeedPostDoc = {
      _id: new ObjectId(),
      authorId: uid,
      text,
      media: input.media,
      likeCount: 0,
      commentCount: 0,
      status: 'active',
      score: trendingScore(0, 0, now, now),
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.col.feedPosts.insertOne(doc);
    return (await this.hydrate([doc], uid))[0]!;
  }

  async list(
    viewerUid: string,
    opts: {
      tab: 'latest' | 'trending' | 'following' | 'user';
      authorId?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    await this.assertEnabled();
    const q: Filter<FeedPostDoc> = { status: 'active' };
    if (opts.tab === 'user' && opts.authorId) q.authorId = opts.authorId;
    if (opts.tab === 'following') {
      const following = await this.ctx.col.follows
        .find({ followerId: viewerUid }, { projection: { followeeId: 1 } })
        .limit(2000)
        .toArray();
      q.authorId = { $in: [viewerUid, ...following.map((f) => f.followeeId)] };
    }
    const blocked = await this.ctx.col.blocks
      .find({ $or: [{ blockerId: viewerUid }, { blockedId: viewerUid }] })
      .limit(1000)
      .toArray();
    const hidden = blocked.map((b) => (b.blockerId === viewerUid ? b.blockedId : b.blockerId));

    if (opts.tab === 'trending') {
      // Offset paging over a bounded, score-sorted window (scores change, so no stable cursor).
      const offset = opts.cursor
        ? Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString(), 10) || 0
        : 0;
      const since = new Date(this.ctx.clock.now().getTime() - TRENDING_WINDOW_DAYS * 86_400_000);
      const rows = await this.ctx.col.feedPosts
        .find({
          ...q,
          createdAt: { $gte: since },
          ...(hidden.length ? { authorId: { $nin: hidden } } : {}),
        })
        .sort({ score: -1, _id: -1 })
        .skip(offset)
        .limit(opts.limit + 1)
        .toArray();
      const page = rows.slice(0, opts.limit);
      return {
        items: await this.hydrate(page, viewerUid),
        nextCursor:
          rows.length > opts.limit
            ? Buffer.from(String(offset + opts.limit)).toString('base64url')
            : null,
      };
    }

    Object.assign(q, afterCursor(opts.cursor));
    if (hidden.length && !q.authorId) q.authorId = { $nin: hidden };
    const rows = await this.ctx.col.feedPosts
      .find(q)
      .sort({ createdAt: -1, _id: -1 })
      .limit(opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit).filter((p) => !hidden.includes(p.authorId));
    const last = rows.slice(0, opts.limit).at(-1);
    return {
      items: await this.hydrate(page, viewerUid),
      nextCursor:
        rows.length > opts.limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  async get(viewerUid: string, postId: ObjectId) {
    const post = await this.ctx.col.feedPosts.findOne({ _id: postId, status: 'active' });
    if (!post) throw notFound('Post');
    return (await this.hydrate([post], viewerUid))[0]!;
  }

  async remove(uid: string, postId: ObjectId, isAdmin: boolean): Promise<void> {
    const res = await this.ctx.col.feedPosts.updateOne(
      { _id: postId, status: { $ne: 'removed' }, ...(isAdmin ? {} : { authorId: uid }) },
      { $set: { status: 'removed', updatedAt: this.ctx.clock.now() } },
    );
    if (!res.matchedCount) throw notFound('Post');
  }

  private async rescore(postId: ObjectId): Promise<void> {
    const p = await this.ctx.col.feedPosts.findOne(
      { _id: postId },
      { projection: { likeCount: 1, commentCount: 1, createdAt: 1 } },
    );
    if (!p) return;
    await this.ctx.col.feedPosts.updateOne(
      { _id: postId },
      {
        $set: {
          score: trendingScore(p.likeCount, p.commentCount, p.createdAt, this.ctx.clock.now()),
        },
      },
    );
  }

  async like(uid: string, postId: ObjectId, liked: boolean): Promise<{ likeCount: number }> {
    const post = await this.ctx.col.feedPosts.findOne(
      { _id: postId, status: 'active' },
      { projection: { authorId: 1 } },
    );
    if (!post) throw notFound('Post');
    let changed = false;
    if (liked) {
      try {
        await this.ctx.col.feedLikes.insertOne({
          postId,
          userId: uid,
          createdAt: this.ctx.clock.now(),
        });
        changed = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    } else {
      changed = (await this.ctx.col.feedLikes.deleteOne({ postId, userId: uid })).deletedCount > 0;
    }
    if (changed) {
      await this.ctx.col.feedPosts.updateOne(
        { _id: postId },
        { $inc: { likeCount: liked ? 1 : -1 } },
      );
      await this.rescore(postId);
      if (liked && post.authorId !== uid) {
        void this.ctx.services.notifications
          .notify(
            post.authorId,
            {
              type: 'like',
              title: 'New like',
              body: 'Someone liked your post',
              data: { postId: String(postId), userId: uid },
            },
            { push: false },
          )
          .catch(() => undefined);
      }
    }
    const fresh = await this.ctx.col.feedPosts.findOne(
      { _id: postId },
      { projection: { likeCount: 1 } },
    );
    return { likeCount: fresh?.likeCount ?? 0 };
  }

  async comment(uid: string, postId: ObjectId, text: string) {
    await this.assertEnabled();
    const post = await this.ctx.col.feedPosts.findOne(
      { _id: postId, status: 'active' },
      { projection: { authorId: 1 } },
    );
    if (!post) throw notFound('Post');
    if (await this.ctx.services.users.isBlockedEitherWay(uid, post.authorId))
      throw forbidden('You cannot comment on this post');
    const clean = await this.ctx.services.moderation.assertClean(text, 'comment');
    const doc = {
      _id: new ObjectId(),
      postId,
      authorId: uid,
      text: clean,
      status: 'active' as const,
      createdAt: this.ctx.clock.now(),
    };
    await this.ctx.col.feedComments.insertOne(doc);
    await this.ctx.col.feedPosts.updateOne({ _id: postId }, { $inc: { commentCount: 1 } });
    await this.rescore(postId);
    if (post.authorId !== uid) {
      void this.ctx.services.notifications
        .notify(post.authorId, {
          type: 'comment',
          title: 'New comment',
          body: clean.slice(0, 100),
          data: { postId: String(postId), userId: uid },
        })
        .catch(() => undefined);
    }
    const briefs = await this.ctx.services.users.briefs([uid]);
    return {
      id: String(doc._id),
      author: briefs.get(uid) ?? null,
      text: doc.text,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async comments(postId: ObjectId, cursor: string | undefined, limit: number) {
    const rows = await this.ctx.col.feedComments
      .find({ postId, status: 'active', ...afterCursor(cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const briefs = await this.ctx.services.users.briefs(page.map((c) => c.authorId));
    const last = page.at(-1);
    return {
      items: page.map((c) => ({
        id: String(c._id),
        author: briefs.get(c.authorId) ?? (null as UserBrief | null),
        text: c.text,
        createdAt: c.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  async removeComment(uid: string, commentId: ObjectId, isAdmin: boolean): Promise<void> {
    const c = await this.ctx.col.feedComments.findOne({ _id: commentId, status: 'active' });
    if (!c) throw notFound('Comment');
    if (!isAdmin && c.authorId !== uid) {
      const post = await this.ctx.col.feedPosts.findOne(
        { _id: c.postId },
        { projection: { authorId: 1 } },
      );
      if (post?.authorId !== uid) throw forbidden();
    }
    await this.ctx.col.feedComments.updateOne({ _id: commentId }, { $set: { status: 'removed' } });
    await this.ctx.col.feedPosts.updateOne({ _id: c.postId }, { $inc: { commentCount: -1 } });
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async adminList(
    filter: { status?: FeedPostDoc['status']; authorId?: string },
    page: number,
    pageSize: number,
  ) {
    const q: Filter<FeedPostDoc> = {};
    if (filter.status) q.status = filter.status;
    if (filter.authorId) q.authorId = filter.authorId;
    const [items, total] = await Promise.all([
      this.ctx.col.feedPosts
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.feedPosts.countDocuments(q),
    ]);
    const briefs = await this.ctx.services.users.briefs(items.map((i) => i.authorId));
    return {
      items: items.map((i) => ({ ...i, author: briefs.get(i.authorId) ?? null })),
      total,
      page,
      pageSize,
    };
  }

  async setStatus(postId: ObjectId, status: FeedPostDoc['status']): Promise<void> {
    const res = await this.ctx.col.feedPosts.updateOne(
      { _id: postId },
      { $set: { status, updatedAt: this.ctx.clock.now() } },
    );
    if (!res.matchedCount) throw notFound('Post');
  }
}
