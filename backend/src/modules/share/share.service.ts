import { DEEP_LINK_ROUTES, type DeepLinkKind } from '@bigboss/shared';
import { ObjectId } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { UserDoc } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { BRIEF_PROJECTION, toUserBrief } from '../users/users.presenter.js';

/** Who a share page shows: enough for a card, nothing private. */
interface SharePerson {
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
}

export type SharePreview =
  | {
      kind: 'live';
      type: 'video' | 'audio';
      status: 'live' | 'ended';
      title: string;
      coverUrl: string | null;
      host: SharePerson;
    }
  | { kind: 'user'; user: SharePerson & { level: number; followers: number } }
  | { kind: 'post'; text: string; imageUrl: string | null; author: SharePerson };

/** How long link-web (and any proxy) may reuse a preview, by kind. */
export const PREVIEW_MAX_AGE: Record<DeepLinkKind, number> = { live: 30, user: 300, post: 300 };

/**
 * Anonymous previews behind share links (`DEEP_LINK_ROUTES`), read by link-web to render the
 * page someone sees before the app opens. A missing, banned or deleted target is a plain 404,
 * the same as an id that never existed.
 */
export class ShareService {
  constructor(private readonly ctx: Ctx) {}

  async preview(kind: DeepLinkKind, id: string): Promise<SharePreview> {
    const route = DEEP_LINK_ROUTES.find((r) => r.kind === kind);
    if (!route || !route.id.test(id)) throw notFound('Link');
    switch (kind) {
      case 'live':
        return this.live(id);
      case 'user':
        return this.user(id);
      case 'post':
        return this.post(id);
    }
  }

  private async live(id: string): Promise<SharePreview> {
    const room = await this.ctx.col.liveRooms.findOne(
      { _id: new ObjectId(id) },
      { projection: { hostId: 1, type: 1, title: 1, coverUrl: 1, status: 1 } },
    );
    const host = room && (await this.activeUser({ _id: room.hostId }));
    if (!room || !host) throw notFound('Live');
    return {
      kind: 'live',
      type: room.type,
      status: room.status,
      title: room.title,
      coverUrl: room.coverUrl,
      host: this.person(host),
    };
  }

  private async user(shortId: string): Promise<SharePreview> {
    const user = await this.activeUser({ shortId });
    if (!user) throw notFound('User');
    const brief = toUserBrief(user, this.ctx.clock.now());
    return {
      kind: 'user',
      user: { ...this.person(user), level: brief.level, followers: user.stats.followers },
    };
  }

  private async post(id: string): Promise<SharePreview> {
    const post = await this.ctx.col.feedPosts.findOne({
      _id: new ObjectId(id),
      status: 'active',
    });
    const author = post && (await this.activeUser({ _id: post.authorId }));
    if (!post || !author) throw notFound('Post');
    return {
      kind: 'post',
      text: post.text,
      imageUrl: post.media.find((m) => m.type === 'image')?.url ?? null,
      author: this.person(author),
    };
  }

  private activeUser(filter: { _id: string } | { shortId: string }) {
    return this.ctx.col.users.findOne(
      { ...filter, status: 'active' },
      { projection: { ...BRIEF_PROJECTION, stats: 1 } },
    ) as Promise<UserDoc | null>;
  }

  private person(u: UserDoc): SharePerson {
    return { shortId: u.shortId, displayName: u.displayName, avatarUrl: u.avatarUrl };
  }
}
