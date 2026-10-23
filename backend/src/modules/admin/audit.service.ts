import type { Request } from 'express';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { AuditLogDoc } from '../../db/schema.js';
import { clientIp, currentUser } from '../../lib/http.js';

/** Append-only record of every admin write. Never fails the admin action it records. */
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
        adminRole: auth.adminRole ?? 'support',
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

  async list(
    filter: { adminId?: string; action?: string; targetId?: string },
    page: number,
    pageSize: number,
  ) {
    const q: Filter<AuditLogDoc> = {};
    if (filter.adminId) q.adminId = filter.adminId;
    if (filter.action) q.action = filter.action;
    if (filter.targetId) q.targetId = filter.targetId;
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
