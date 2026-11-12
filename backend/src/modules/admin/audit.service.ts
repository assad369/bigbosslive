import type { Request } from 'express';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { AuditLogDoc } from '../../db/schema.js';
import { SHORT_ID_PATTERN } from '@bigboss/shared';
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
      /** Actor uid, or their short id. */
      adminId?: string;
      action?: string;
      /** Action prefix, e.g. `wallet` matches `wallet.adjust` and `wallet.recharge`. */
      domain?: string;
      targetId?: string;
      /** `staff`, `platform_moderator` or `system`. */
      actorKind?: 'staff' | 'platform_moderator' | 'system';
      from?: Date;
      to?: Date;
    },
    page: number,
    pageSize: number,
  ) {
    const q: Filter<AuditLogDoc> = {};
    if (filter.adminId) q.adminId = await this.actorUid(filter.adminId);
    if (filter.action) q.action = filter.action;
    else if (filter.domain) q.action = { $regex: `^${escapeRegex(filter.domain)}\\.` };
    if (filter.targetId) q.targetId = filter.targetId;
    if (filter.actorKind === 'staff')
      q.adminRole = { $nin: ['system', 'platform_moderator', 'user'] };
    else if (filter.actorKind) q.adminRole = filter.actorKind;
    if (filter.from || filter.to)
      q.createdAt = {
        ...(filter.from ? { $gte: filter.from } : {}),
        ...(filter.to ? { $lte: filter.to } : {}),
      };
    const [rows, total] = await Promise.all([
      this.ctx.col.auditLogs
        .find(q)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.auditLogs.countDocuments(q),
    ]);
    // Names for the dashboard: who acted, and the person the row is about (if any).
    const briefs = await this.ctx.services.users.briefs(
      rows.flatMap((r) => [r.adminId, subjectUid(r)]).filter((u): u is string => !!u),
    );
    const items = rows.map((r) => {
      const subject = subjectUid(r);
      return {
        ...r,
        actor: r.adminId === 'system' ? null : (briefs.get(r.adminId) ?? null),
        subject: subject ? (briefs.get(subject) ?? null) : null,
      };
    });
    return { items, total, page, pageSize };
  }

  /** A short id names the account that holds it (any status); anything else is a uid. */
  private async actorUid(id: string): Promise<string> {
    const trimmed = id.trim();
    if (!SHORT_ID_PATTERN.test(trimmed)) return trimmed;
    const user = await this.ctx.col.users.findOne({ shortId: trimmed }, { projection: { _id: 1 } });
    return user?._id ?? trimmed;
  }
}

/** The user an entry is about: its target, or the user its payload names (kicks, members, lives). */
function subjectUid(r: AuditLogDoc): string | null {
  if (r.targetType === 'user') return r.targetId;
  const p = r.payload;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  for (const key of ['userId', 'uid', 'hostId']) {
    const v = o[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
