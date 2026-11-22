import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  REPORT_REASONS,
  REPORT_TARGETS,
  type ReportStatus,
  type ReportTarget,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { ReportDoc } from '../../db/schema.js';
import { AppError, badRequest, conflict, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { filterText } from './textFilter.js';

export const reportInput = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.string().min(1).max(128),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000).default(''),
});

const DEVICE_CACHE_TTL_MS = 60_000;

export class ModerationService {
  private deviceCache = new Map<string, { banned: boolean; at: number }>();

  constructor(private readonly ctx: Ctx) {}

  /** Mask profanity; returns the cleaned text. Never throws. */
  async cleanText(text: string): Promise<string> {
    const cfg = await this.ctx.services.config.get('moderation');
    return filterText(text, cfg.blockedWords).text;
  }

  /**
   * Mask profanity and reject contact info. Use on every endpoint that accepts free text
   * (chat, comments, posts, room titles, profile fields).
   *
   * `allowNumbers` lets phone numbers through (private inbox messages); links and messenger
   * handles are still refused.
   */
  async assertClean(
    text: string,
    field = 'text',
    opts: { allowNumbers?: boolean } = {},
  ): Promise<string> {
    const cfg = await this.ctx.services.config.get('moderation');
    const res = filterText(text, cfg.blockedWords);
    if (cfg.blockContactInfo && (opts.allowNumbers ? res.link : res.contactInfo)) {
      throw new AppError(
        422,
        'contact_info_blocked',
        opts.allowNumbers
          ? `Links and messenger handles are not allowed in ${field}`
          : `Contact details and links are not allowed in ${field}`,
      );
    }
    return res.text;
  }

  // ── Device bans ────────────────────────────────────────────────────────────

  async isDeviceBanned(deviceId: string): Promise<boolean> {
    const hit = this.deviceCache.get(deviceId);
    if (hit && Date.now() - hit.at < DEVICE_CACHE_TTL_MS) return hit.banned;
    const banned =
      (await this.ctx.col.deviceBans.countDocuments({ _id: deviceId }, { limit: 1 })) > 0;
    this.deviceCache.set(deviceId, { banned, at: Date.now() });
    return banned;
  }

  /** Ban a device and (optionally) every account that has used it. */
  async banDevice(
    deviceId: string,
    opts: { reason: string; by: string; cascade: boolean },
  ): Promise<{ bannedUsers: number }> {
    try {
      await this.ctx.col.deviceBans.insertOne({
        _id: deviceId,
        reason: opts.reason,
        by: opts.by,
        createdAt: this.ctx.clock.now(),
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    this.deviceCache.delete(deviceId);
    let bannedUsers = 0;
    if (opts.cascade) {
      const users = await this.ctx.col.devices.distinct('userId', { deviceId });
      for (const uid of users) {
        await this.ctx.services.users
          .ban(uid, { reason: `Device ban: ${opts.reason}`, until: null, by: opts.by })
          .then(() => bannedUsers++)
          .catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'cascade ban failed'));
      }
    }
    return { bannedUsers };
  }

  async unbanDevice(deviceId: string): Promise<void> {
    const res = await this.ctx.col.deviceBans.deleteOne({ _id: deviceId });
    if (!res.deletedCount) throw notFound('Device ban');
    this.deviceCache.delete(deviceId);
  }

  async devicesForUser(uid: string) {
    return this.ctx.col.devices.find({ userId: uid }).sort({ lastSeenAt: -1 }).limit(50).toArray();
  }

  async usersForDevice(deviceId: string) {
    const rows = await this.ctx.col.devices
      .find({ deviceId })
      .sort({ lastSeenAt: -1 })
      .limit(200)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      lastSeenAt: r.lastSeenAt,
      platform: r.platform,
    }));
  }

  // ── Reports ─────────────────────────────────────────────────────────────────

  async report(reporterId: string, input: z.infer<typeof reportInput>): Promise<ReportDoc> {
    if (input.targetType === 'user' && input.targetId === reporterId)
      throw badRequest('You cannot report yourself');
    if (input.targetType === 'concern' && input.details.length < 10)
      throw badRequest('Describe what happened (at least 10 characters)');
    const { targetType, snapshot } = await this.reportTarget(reporterId, input);
    const priority = input.reason === 'child_safety' ? 'urgent' : 'normal';
    const doc: ReportDoc = {
      _id: new ObjectId(),
      reporterId,
      targetType,
      targetId: input.targetId,
      reason: input.reason,
      details: input.details,
      status: 'open',
      priority,
      snapshot,
      resolution: null,
      createdAt: this.ctx.clock.now(),
    };
    try {
      await this.ctx.col.reports.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('You already reported this', 'already_reported');
      throw err;
    }
    if (priority === 'urgent') {
      // Child safety: an error-level line for log alerting, and an audit row staff can find.
      this.ctx.log.error(
        { reportId: String(doc._id), targetType, targetId: input.targetId },
        'child_safety_report',
      );
      await this.ctx.services.audit.recordSystem(
        'report.child_safety',
        { type: 'report', id: String(doc._id) },
        { targetType, targetId: input.targetId },
      );
    }
    return doc;
  }

  /**
   * Resolves the legacy `message` target to `live_message` or `dm`, and copies the reported
   * content so the evidence outlives it (room chat expires after a week; authors delete).
   * An inbox message is only copied for one of its two participants.
   */
  private async reportTarget(
    reporterId: string,
    input: z.infer<typeof reportInput>,
  ): Promise<{ targetType: ReportTarget; snapshot: ReportDoc['snapshot'] }> {
    const { targetType, targetId } = input;
    if (!['message', 'live_message', 'dm', 'post', 'comment'].includes(targetType))
      return { targetType, snapshot: null };
    if (!ObjectId.isValid(targetId)) return { targetType, snapshot: null };
    const _id = new ObjectId(targetId);

    if (targetType === 'message' || targetType === 'live_message') {
      const live = await this.ctx.col.liveMessages.findOne({ _id });
      if (live)
        return {
          targetType: 'live_message',
          snapshot: {
            authorId: live.userId,
            text: live.text || null,
            mediaUrl: live.voice?.url ?? null,
            createdAt: live.createdAt,
          },
        };
      if (targetType === 'live_message') return { targetType, snapshot: null };
    }
    if (targetType === 'message' || targetType === 'dm') {
      const dm = await this.ctx.col.messages.findOne({ _id });
      if (!dm) return { targetType, snapshot: null };
      const conv = await this.ctx.col.conversations.findOne(
        { _id: dm.conversationId },
        { projection: { participants: 1 } },
      );
      const party = conv?.participants.includes(reporterId) ?? false;
      return {
        targetType: 'dm',
        snapshot: party
          ? {
              authorId: dm.senderId,
              text: dm.text,
              mediaUrl: dm.mediaUrl,
              createdAt: dm.createdAt,
            }
          : null,
      };
    }
    if (targetType === 'post') {
      const post = await this.ctx.col.feedPosts.findOne({ _id });
      return {
        targetType,
        snapshot: post
          ? {
              authorId: post.authorId,
              text: post.text,
              mediaUrl: post.media[0]?.url ?? null,
              createdAt: post.createdAt,
            }
          : null,
      };
    }
    const comment = await this.ctx.col.feedComments.findOne({ _id });
    return {
      targetType,
      snapshot: comment
        ? {
            authorId: comment.authorId,
            text: comment.text,
            mediaUrl: null,
            createdAt: comment.createdAt,
          }
        : null,
    };
  }

  /** Open child-safety reports: the admin shows a banner while any wait. */
  async urgentOpenCount(): Promise<number> {
    return this.ctx.col.reports.countDocuments({ status: 'open', priority: 'urgent' });
  }

  async listReports(
    filter: { status?: ReportStatus; targetType?: ReportTarget },
    page: number,
    pageSize: number,
  ) {
    const q: Filter<ReportDoc> = {};
    if (filter.status) q.status = filter.status;
    if (filter.targetType) q.targetType = filter.targetType;
    const [items, total] = await Promise.all([
      this.ctx.col.reports
        .find(q)
        .sort({ priority: -1, createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.reports.countDocuments(q),
    ]);
    return { items, total, page, pageSize };
  }

  async resolveReport(
    id: ObjectId,
    opts: { by: string; status: 'resolved' | 'dismissed'; action: string; note: string | null },
  ) {
    const res = await this.ctx.col.reports.findOneAndUpdate(
      { _id: id, status: 'open' },
      {
        $set: {
          status: opts.status,
          resolution: {
            by: opts.by,
            action: opts.action,
            note: opts.note,
            at: this.ctx.clock.now(),
          },
        },
      },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Open report');
    return res;
  }
}
