import type { Request } from 'express';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { AuditLogDoc } from '../../db/schema.js';
import { clientIp, currentUser } from '../../lib/http.js';
import { isPlatformModerator } from '../moderation/authority.js';

/**
 * Append-only record of every admin write, and of every platform moderator action in the app.
 * Never fails the action it records.
 */
export class AuditService {
  constructor(private readonly ctx: Ctx) {}

  async record(
    req: Request,
    action: string,
    target: { type: string; id: string | null },
    payload?: unknown,
  ): Promise<void> {
    const auth = currentUser(req);
    try {
      await this.ctx.col.auditLogs.insertOne({
        adminId: auth.uid,
        // Staff by their claim; app users who moderate as platform moderators.
        adminRole:
          auth.adminRole ?? (isPlatformModerator(auth.user) ? 'platform_moderator' : 'user'),
        action,
        targetType: target.type,
        targetId: target.id,
        payload: payload ?? null,
        ip: clientIp(req),
        createdAt: this.ctx.clock.now(),
      });
    } catch (err) {
      this.ctx.log.error({ err, action }, 'audit log write failed');
    }
  }

  /** An automated action with no admin behind it (SightGuard verdicts). Never throws. */
  async recordSystem(
    action: string,
    target: { type: string; id: string | null },
    payload?: unknown,
  ): Promise<void> {
    try {
      await this.ctx.col.auditLogs.insertOne({
        adminId: 'system',
        adminRole: 'system',
        action,
        targetType: target.type,
        targetId: target.id,
        payload: payload ?? null,
        ip: '',
        createdAt: this.ctx.clock.now(),
      });
    } catch (err) {
      this.ctx.log.error({ err, action }, 'audit log write failed');
    }
  }

  async list(
    filter: {
      adminId?: string;
      action?: string;
      targetId?: string;
      /** `staff`, `platform_moderator` or `system`. */
      actorKind?: 'staff' | 'platform_moderator' | 'system';
    },
    page: number,
    pageSize: number,
  ) {
    const q: Filter<AuditLogDoc> = {};
    if (filter.adminId) q.adminId = filter.adminId;
    if (filter.action) q.action = filter.action;
    if (filter.targetId) q.targetId = filter.targetId;
    if (filter.actorKind === 'staff')
      q.adminRole = { $nin: ['system', 'platform_moderator', 'user'] };
    else if (filter.actorKind) q.adminRole = filter.actorKind;
    const [items, total] = await Promise.all([
      this.ctx.col.auditLogs
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.auditLogs.countDocuments(q),
    ]);
    return { items, total, page, pageSize };
  }
}
