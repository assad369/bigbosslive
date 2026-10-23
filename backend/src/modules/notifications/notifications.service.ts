import { createHash } from 'node:crypto';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { SOCKET } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { AnnouncementDoc, NotificationDoc, UserDoc } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';

export const announcementInput = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(500),
  imageUrl: z.url().nullable().default(null),
  audience: z.enum(['all', 'hosts', 'agents', 'vip']).default('all'),
});

export const pushTokenInput = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios', 'web']),
});

/** Deterministic inbox id per (announcement, user). */
const inboxId = (announcementId: string, uid: string) =>
  new ObjectId(createHash('sha1').update(`${announcementId}:${uid}`).digest('hex').slice(0, 24));

type NotifyInput = Pick<NotificationDoc, 'type' | 'title' | 'body'> & { data?: Record<string, string> };

/** In-app inbox + FCM push. The inbox row is the record; push is best-effort delivery. */
export class NotificationsService {
  constructor(private readonly ctx: Ctx) {}

  async notify(uid: string, input: NotifyInput, opts: { push?: boolean } = {}): Promise<void> {
    const doc: NotificationDoc = {
      _id: new ObjectId(),
      userId: uid,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      readAt: null,
      createdAt: this.ctx.clock.now(),
    };
    await this.ctx.col.notifications.insertOne(doc);
    this.ctx.realtime.toUser(SOCKET.namespaces.app, uid, SOCKET.app.notification, this.present(doc));
    if (opts.push ?? true) {
      await this.ctx.jobs.enqueue('push.user', { userId: uid, title: input.title, body: input.body, data: { type: input.type, ...input.data } });
    }
  }

  present(n: NotificationDoc) {
    return { id: String(n._id), type: n.type, title: n.title, body: n.body, data: n.data, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() };
  }

  async list(uid: string, cursor: string | undefined, limit: number) {
    const rows = await this.ctx.col.notifications
      .find({ userId: uid, ...afterCursor(cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map((n) => this.present(n)), nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, String(last._id)) : null };
  }

  async unreadCount(uid: string): Promise<number> {
    return this.ctx.col.notifications.countDocuments({ userId: uid, readAt: null });
  }

  async markRead(uid: string, ids: ObjectId[] | 'all'): Promise<void> {
    const q: Filter<NotificationDoc> = { userId: uid, readAt: null, ...(ids === 'all' ? {} : { _id: { $in: ids } }) };
    await this.ctx.col.notifications.updateMany(q, { $set: { readAt: this.ctx.clock.now() } });
  }

  // ── Push tokens ─────────────────────────────────────────────────────────────

  async registerToken(uid: string, token: string, platform: 'android' | 'ios' | 'web'): Promise<void> {
    // Re-keyed on the token: a device that switches accounts moves to the new user.
    await this.ctx.col.pushTokens.updateOne({ _id: token }, { $set: { userId: uid, platform, updatedAt: this.ctx.clock.now() } }, { upsert: true });
  }

  async removeToken(uid: string, token: string): Promise<void> {
    await this.ctx.col.pushTokens.deleteOne({ _id: token, userId: uid });
  }

  async pushToUsers(uids: string[], message: { title: string; body: string; imageUrl?: string | null; data?: Record<string, string> }) {
    if (!uids.length) return { successCount: 0, failureCount: 0 };
    const tokens = await this.ctx.col.pushTokens.find({ userId: { $in: uids } }, { projection: { _id: 1 } }).toArray();
    if (!tokens.length) return { successCount: 0, failureCount: 0 };
    const res = await this.ctx.push.sendToTokens(tokens.map((t) => t._id), message);
    if (res.invalidTokens.length) await this.ctx.col.pushTokens.deleteMany({ _id: { $in: res.invalidTokens } });
    return { successCount: res.successCount, failureCount: res.failureCount };
  }

  // ── Announcements (admin broadcast) ────────────────────────────────────────────

  async createAnnouncement(adminId: string, input: z.infer<typeof announcementInput>): Promise<AnnouncementDoc> {
    const doc: AnnouncementDoc = {
      _id: new ObjectId(),
      ...input,
      status: 'queued',
      sentBy: adminId,
      stats: { recipients: 0, pushed: 0, failed: 0 },
      createdAt: this.ctx.clock.now(),
      completedAt: null,
    };
    await this.ctx.col.announcements.insertOne(doc);
    await this.ctx.jobs.enqueue('announcement.send', { announcementId: String(doc._id) });
    return doc;
  }

  async announcements(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.ctx.col.announcements.find().sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      this.ctx.col.announcements.countDocuments(),
    ]);
    return { items, total, page, pageSize };
  }

  /** Job handler: write inbox rows and push in batches of 500 recipients. */
  async sendAnnouncement(id: ObjectId): Promise<void> {
    const ann = await this.ctx.col.announcements.findOneAndUpdate({ _id: id, status: { $in: ['queued', 'sending'] } }, { $set: { status: 'sending' } }, { returnDocument: 'after' });
    if (!ann) throw notFound('Announcement');
    const audience: Filter<UserDoc> = { status: 'active' };
    if (ann.audience === 'agents') audience.isAgent = true;
    if (ann.audience === 'vip') audience['vip.expiresAt'] = { $gt: this.ctx.clock.now() };
    if (ann.audience === 'hosts') audience['stats.liveSeconds'] = { $gt: 0 };

    const stats = { recipients: 0, pushed: 0, failed: 0 };
    let batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const now = this.ctx.clock.now();
      // Deterministic ids make a retried batch a no-op instead of duplicating inbox rows.
      await this.ctx.col.notifications
        .insertMany(
          batch.map((uid) => ({ _id: inboxId(String(ann._id), uid), userId: uid, type: 'system' as const, title: ann.title, body: ann.body, data: { announcementId: String(ann._id) }, readAt: null, createdAt: now })),
          { ordered: false },
        )
        // Duplicate-key errors here are the retried rows we want to skip.
        .catch((err: unknown) => this.ctx.log.debug({ err }, 'announcement inbox batch had existing rows'));
      const res = await this.pushToUsers(batch, { title: ann.title, body: ann.body, imageUrl: ann.imageUrl, data: { type: 'system', announcementId: String(ann._id) } });
      stats.recipients += batch.length;
      stats.pushed += res.successCount;
      stats.failed += res.failureCount;
      batch = [];
      await this.ctx.col.announcements.updateOne({ _id: ann._id }, { $set: { stats } });
    };
    for await (const u of this.ctx.col.users.find(audience, { projection: { _id: 1 } })) {
      batch.push(u._id);
      if (batch.length >= 500) await flush();
    }
    await flush();
    await this.ctx.col.announcements.updateOne({ _id: ann._id }, { $set: { status: 'sent', stats, completedAt: this.ctx.clock.now() } });
  }

  /** Job handler: tell a host's followers they went live. */
  async pushFollowersGoLive(hostId: string, roomId: string): Promise<void> {
    const host = await this.ctx.col.users.findOne({ _id: hostId }, { projection: { displayName: 1 } });
    if (!host) return;
    let batch: string[] = [];
    const message = { title: `${host.displayName} is live now`, body: 'Tap to join the live', data: { type: 'live', roomId } };
    for await (const uid of this.ctx.services.follows.followerIds(hostId)) {
      batch.push(uid);
      if (batch.length >= 500) {
        await this.pushToUsers(batch, message);
        batch = [];
      }
    }
    await this.pushToUsers(batch, message);
  }
}
