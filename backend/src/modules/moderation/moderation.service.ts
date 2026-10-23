import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { REPORT_TARGETS, type ReportStatus, type ReportTarget } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { ReportDoc } from '../../db/schema.js';
import { AppError, badRequest, conflict, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { filterText } from './textFilter.js';

export const reportInput = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.string().min(1).max(128),
  reason: z.enum(['spam', 'harassment', 'nudity', 'violence', 'hate', 'scam', 'underage', 'other']),
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
   */
  async assertClean(text: string, field = 'text'): Promise<string> {
    const cfg = await this.ctx.services.config.get('moderation');
    const res = filterText(text, cfg.blockedWords);
    if (cfg.blockContactInfo && res.contactInfo) {
      throw new AppError(
        422,
        'contact_info_blocked',
        `Contact details and links are not allowed in ${field}`,
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
    const doc: ReportDoc = {
      _id: new ObjectId(),
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      details: input.details,
      status: 'open',
      resolution: null,
      createdAt: this.ctx.clock.now(),
    };
    try {
      await this.ctx.col.reports.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('You already reported this', 'already_reported');
      throw err;
    }
    return doc;
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
        .sort({ createdAt: -1 })
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
