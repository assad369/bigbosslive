import { z } from 'zod';
import type { Filter } from 'mongodb';
import type {
  AdminRole,
  DeviceBanPreview,
  DeviceBanResult,
  ModeratedDevice,
  ModeratedRoomBan,
  ModeratedUser,
  UserBrief,
} from '@bigboss/shared';
import { SHORT_ID_PATTERN } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { UserDoc } from '../../db/schema.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/http.js';
import { once } from '../../lib/idempotency.js';
import { addDays } from '../../lib/time.js';
import { hasPermission } from '../../middleware/rbac.js';
import { toUserBrief } from '../users/users.presenter.js';
import { isPlatformModerator, isProtected } from './authority.js';

/** Ban lengths a platform moderator may pick; null = until lifted. */
export const MODERATOR_BAN_DAYS = [1, 7, 30] as const;

export const moderatorBanInput = z.object({
  reason: z.string().trim().min(3).max(200),
  days: z
    .union([z.literal(1), z.literal(7), z.literal(30)])
    .nullable()
    .default(null),
  /** Also ban every device this account signed in from, and the accounts on them. */
  banDevices: z.boolean().default(false),
});

export const moderatorSearchQuery = z.object({
  q: z.string().trim().max(60).default(''),
  status: z.enum(['all', 'banned', 'active']).default('all'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Audit actions that count against a moderator's hourly ban allowance. */
export const BAN_ACTIONS = ['moderator.user_ban', 'moderator.device_ban'] as const;

const PANEL_PROJECTION = {
  shortId: 1,
  displayName: 1,
  avatarUrl: 1,
  level: 1,
  vip: 1,
  country: 1,
  equipped: 1,
  status: 1,
  ban: 1,
  adminRole: 1,
  platformModerator: 1,
  isAgent: 1,
  createdAt: 1,
} as const;

type PanelUser = Pick<
  UserDoc,
  | '_id'
  | 'shortId'
  | 'displayName'
  | 'avatarUrl'
  | 'level'
  | 'vip'
  | 'country'
  | 'equipped'
  | 'status'
  | 'ban'
  | 'adminRole'
  | 'platformModerator'
  | 'isAgent'
  | 'createdAt'
>;

/** Who is acting through the Moderation panel. */
export interface ModeratorActor {
  uid: string;
  /** The verified token's claim: staff with `users.moderate` may act on protected accounts. */
  adminRole: AdminRole | null;
  /** The device the request came from (`X-Device-Id`): never banned by its own user. */
  deviceId: string | null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Platform moderators: app users an admin trusted to moderate from inside the app, with no
 * dashboard access. This service backs the admin's grant/revoke and the app's Moderation
 * panel (search, ban/unban, devices, the hosts' live bans).
 *
 * Rules every action here keeps:
 * - Nobody acts on themselves, and only staff act on staff or other platform moderators
 *   (`target_protected`). A device cascade skips protected accounts instead of failing.
 * - Bans and device bans are keyed by `Idempotency-Key` and capped per moderator per hour
 *   (`platformModerators.banRateLimitPerHour`), counted from the audit log the routes write.
 * - Nothing here returns contact details or another user's device ids beyond the target's.
 */
export class PlatformModeratorsService {
  constructor(private readonly ctx: Ctx) {}

  // ── Granting (admin) ──────────────────────────────────────────────────────────

  /** Platform moderators, newest first. */
  async list(cursor: string | undefined, limit: number) {
    const after = decodeCursor(cursor);
    const filter: Filter<UserDoc> = { platformModerator: { $type: 'object' } } as Filter<UserDoc>;
    if (after)
      Object.assign(filter, {
        $or: [
          { 'platformModerator.since': { $lt: after.date } },
          { 'platformModerator.since': after.date, _id: { $lt: after.id } },
        ],
      });
    const docs = (await this.ctx.col.users
      .find(filter, { projection: PANEL_PROJECTION })
      .sort({ 'platformModerator.since': -1, _id: -1 })
      .limit(limit + 1)
      .toArray()) as PanelUser[];
    const page = docs.slice(0, limit);
    const last = page[page.length - 1];
    const now = this.ctx.clock.now();
    return {
      items: page.map((u) => ({
        user: toUserBrief(u, now),
        since: u.platformModerator!.since.toISOString(),
        by: u.platformModerator!.by,
        status: u.status,
      })),
      nextCursor:
        docs.length > limit && last ? encodeCursor(last.platformModerator!.since, last._id) : null,
    };
  }

  /**
   * Grant or revoke the flag. A revoke also takes them out of every live they watch hidden,
   * so a stealth session can't outlive the role. Returns whether anything changed.
   */
  async setFlag(uid: string, enabled: boolean, by: string): Promise<boolean> {
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { status: 1, platformModerator: 1 } },
    );
    if (!user || user.status === 'deleted') throw notFound('User');
    if (enabled) {
      if (user.status !== 'active') throw badRequest('Lift the ban before granting this role');
      if (user.platformModerator) return false;
      await this.ctx.col.users.updateOne(
        { _id: uid, platformModerator: { $not: { $type: 'object' } } } as Filter<UserDoc>,
        {
          $set: {
            platformModerator: { since: this.ctx.clock.now(), by },
            updatedAt: this.ctx.clock.now(),
          },
        },
      );
      return true;
    }
    if (!user.platformModerator) return false;
    await this.ctx.col.users.updateOne(
      { _id: uid },
      { $set: { platformModerator: null, updatedAt: this.ctx.clock.now() } },
    );
    await this.ctx.services.live
      .dropHidden(uid)
      .catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'drop hidden sessions failed'));
    return true;
  }

  // ── The Moderation panel ──────────────────────────────────────────────────────

  /**
   * Search by exact short id or uid, or by display-name prefix; an empty query lists the
   * newest accounts. Paged on `{createdAt: -1, _id: -1}`.
   */
  async search(q: z.infer<typeof moderatorSearchQuery>) {
    const filter: Record<string, unknown> =
      q.status === 'all' ? { status: { $ne: 'deleted' } } : { status: q.status };
    const term = q.q.trim();
    if (term) {
      const prefix = { displayNameLower: { $regex: `^${escapeRegex(term.toLowerCase())}` } };
      filter.$or = SHORT_ID_PATTERN.test(term)
        ? [{ shortId: term }, { _id: term }, prefix]
        : [{ _id: term }, prefix];
    }
    const after = decodeCursor(q.cursor);
    const and: Record<string, unknown>[] = [filter];
    if (after)
      and.push({
        $or: [
          { createdAt: { $lt: after.date } },
          { createdAt: after.date, _id: { $lt: after.id } },
        ],
      });
    const docs = (await this.ctx.col.users
      .find({ $and: and } as Filter<UserDoc>, { projection: PANEL_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .limit(q.limit + 1)
      .toArray()) as PanelUser[];
    const page = docs.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((u) => this.row(u)),
      nextCursor: docs.length > q.limit && last ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  async get(uid: string): Promise<ModeratedUser> {
    const u = (await this.ctx.col.users.findOne(
      { _id: uid, status: { $ne: 'deleted' } },
      { projection: PANEL_PROJECTION },
    )) as PanelUser | null;
    if (!u) throw notFound('User');
    return this.row(u);
  }

  private row(u: PanelUser): ModeratedUser {
    return {
      user: toUserBrief(u, this.ctx.clock.now()),
      status: u.status,
      ban: u.ban
        ? {
            reason: u.ban.reason,
            until: u.ban.until?.toISOString() ?? null,
            at: u.ban.at.toISOString(),
          }
        : null,
      isPlatformModerator: isPlatformModerator(u),
      isAgent: u.isAgent,
      isStaff: Boolean(u.adminRole),
      createdAt: u.createdAt.toISOString(),
    };
  }

  private isStaff(actor: ModeratorActor): boolean {
    return hasPermission(actor.adminRole, 'users.moderate');
  }

  /** The target, if the actor may act on it. */
  private async target(actor: ModeratorActor, uid: string): Promise<UserDoc> {
    if (uid === actor.uid) throw badRequest('You can’t do that to your own account');
    const target = await this.ctx.col.users.findOne({ _id: uid });
    if (!target || target.status === 'deleted') throw notFound('User');
    if (isProtected(target) && !this.isStaff(actor))
      throw new AppError(
        403,
        'target_protected',
        'Platform moderators and staff can only be acted on by staff',
      );
    return target;
  }

  /** 429 once the actor used up this hour's bans. Counted from the audit rows the routes write. */
  async assertBanAllowance(actor: ModeratorActor): Promise<void> {
    if (this.isStaff(actor)) return;
    const { banRateLimitPerHour } = await this.ctx.services.config.get('platformModerators');
    const since = new Date(this.ctx.clock.now().getTime() - 3_600_000);
    const used = await this.ctx.col.auditLogs.countDocuments({
      adminId: actor.uid,
      action: { $in: [...BAN_ACTIONS] },
      createdAt: { $gt: since },
    });
    if (used >= banRateLimitPerHour)
      throw new AppError(429, 'rate_limited', 'You’ve reached this hour’s ban limit');
  }

  /**
   * Ban an account for 1, 7 or 30 days, or until lifted, optionally with every device it used.
   * Keyed per moderator: a retry returns the first result and bans nothing twice.
   */
  async ban(
    actor: ModeratorActor,
    uid: string,
    input: z.infer<typeof moderatorBanInput>,
    key: string,
  ): Promise<{
    result: { until: string | null; devices: DeviceBanResult | null };
    replayed: boolean;
  }> {
    await this.target(actor, uid);
    const reason = await this.ctx.services.moderation.assertClean(input.reason, 'the reason');
    return once(this.ctx, 'moderator_ban', actor.uid, `${uid}:${key}`, async () => {
      const until = input.days ? addDays(this.ctx.clock.now(), input.days) : null;
      // Every write below is idempotent, so a transaction retry of this callback is harmless.
      await this.ctx.services.users.ban(uid, { reason, until, by: actor.uid });
      let devices: DeviceBanResult | null = null;
      if (input.banDevices) {
        const deviceIds = await this.ctx.col.devices.distinct('deviceId', { userId: uid });
        devices = await this.banDeviceSet(actor, deviceIds, reason, [uid]);
      }
      return { until: until?.toISOString() ?? null, devices };
    });
  }

  async unban(actor: ModeratorActor, uid: string): Promise<void> {
    await this.target(actor, uid);
    await this.ctx.services.users.unban(uid);
  }

  /** Devices the account signed in from, newest first. */
  async devices(actor: ModeratorActor, uid: string): Promise<ModeratedDevice[]> {
    await this.ctx.services.users.get(uid);
    const rows = await this.ctx.services.moderation.devicesForUser(uid);
    const ids = rows.map((r) => r.deviceId);
    const [counts, bans] = await Promise.all([
      ids.length
        ? this.ctx.col.devices
            .aggregate<{ _id: string; n: number }>([
              { $match: { deviceId: { $in: ids } } },
              { $group: { _id: '$deviceId', n: { $sum: 1 } } },
            ])
            .toArray()
        : [],
      ids.length ? this.ctx.col.deviceBans.distinct('_id', { _id: { $in: ids } }) : [],
    ]);
    const count = new Map(counts.map((c) => [c._id, c.n]));
    const banned = new Set(bans);
    return rows.map((r) => ({
      deviceId: r.deviceId,
      platform: r.platform,
      lastSeenAt: r.lastSeenAt.toISOString(),
      accountCount: count.get(r.deviceId) ?? 1,
      banned: banned.has(r.deviceId),
      isYours: r.deviceId === actor.deviceId,
    }));
  }

  /**
   * What banning these devices would do, without doing it: which accounts would be banned
   * and which are skipped (protected accounts, the actor's own) and why.
   */
  private async plan(actor: ModeratorActor, deviceIds: string[], spare: string[] = []) {
    const devices = deviceIds.filter((d) => d !== actor.deviceId);
    const uids = devices.length
      ? await this.ctx.col.devices.distinct('userId', { deviceId: { $in: devices } })
      : [];
    const users = uids.length
      ? await this.ctx.col.users
          .find(
            { _id: { $in: uids } },
            { projection: { status: 1, adminRole: 1, platformModerator: 1 } },
          )
          .toArray()
      : [];
    const staff = this.isStaff(actor);
    const toBan: string[] = [];
    const skipped: { uid: string; reason: string }[] = [];
    let alreadyBanned = 0;
    for (const u of users) {
      if (u._id === actor.uid) skipped.push({ uid: u._id, reason: 'Your own account' });
      else if (u.status === 'deleted') continue;
      else if (u.status === 'banned' && !spare.includes(u._id)) alreadyBanned++;
      else if (spare.includes(u._id)) continue;
      else if (isProtected(u) && !staff)
        skipped.push({
          uid: u._id,
          reason: u.adminRole ? 'Staff account' : 'Platform moderator',
        });
      else toBan.push(u._id);
    }
    return { devices, toBan, skipped, alreadyBanned };
  }

  /** Dry run of banning every device `uid` signed in from. Writes nothing. */
  async previewUserDevices(actor: ModeratorActor, uid: string): Promise<DeviceBanPreview> {
    await this.target(actor, uid);
    const deviceIds = await this.ctx.col.devices.distinct('deviceId', { userId: uid });
    const plan = await this.plan(actor, deviceIds, [uid]);
    const briefs = await this.briefs(plan.skipped.map((s) => s.uid));
    return {
      devices: plan.devices.length,
      // The account itself is banned too.
      accounts: plan.toBan.length + 1,
      alreadyBanned: plan.alreadyBanned,
      skipped: plan.skipped.map((s) => ({ ...s, user: briefs.get(s.uid) ?? null })),
    };
  }

  /** Ban one device (and the accounts on it). Never the actor's own handset. */
  async banDevice(
    actor: ModeratorActor,
    deviceId: string,
    reason: string,
    key: string,
  ): Promise<{ result: DeviceBanResult; replayed: boolean }> {
    if (deviceId === actor.deviceId) throw badRequest('You can’t ban the device you’re using');
    const known = await this.ctx.col.devices.countDocuments({ deviceId }, { limit: 1 });
    if (!known) throw notFound('Device');
    const clean = await this.ctx.services.moderation.assertClean(reason, 'the reason');
    return once(this.ctx, 'moderator_device_ban', actor.uid, `${deviceId}:${key}`, () =>
      this.banDeviceSet(actor, [deviceId], clean),
    );
  }

  private async banDeviceSet(
    actor: ModeratorActor,
    deviceIds: string[],
    reason: string,
    spare: string[] = [],
  ): Promise<DeviceBanResult> {
    const plan = await this.plan(actor, deviceIds, spare);
    for (const deviceId of plan.devices)
      await this.ctx.services.moderation.banDevice(deviceId, {
        reason,
        by: actor.uid,
        cascade: false,
      });
    let accountsBanned = 0;
    for (const uid of plan.toBan) {
      await this.ctx.services.users
        .ban(uid, { reason: `Device ban: ${reason}`, until: null, by: actor.uid })
        .then(() => accountsBanned++)
        .catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'device cascade ban failed'));
    }
    return { devicesBanned: plan.devices.length, accountsBanned, skipped: plan.skipped };
  }

  /** Hosts who banned `uid` from their lives (room bans are per host, across all their lives). */
  async roomBans(uid: string): Promise<ModeratedRoomBan[]> {
    const now = this.ctx.clock.now();
    const rows = await this.ctx.col.roomBans
      .find({ userId: uid, $or: [{ until: null }, { until: { $gt: now } }] })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const briefs = await this.briefs(rows.map((r) => r.hostId));
    return rows.map((r) => ({
      host: briefs.get(r.hostId) ?? null,
      hostId: r.hostId,
      until: r.until?.toISOString() ?? null,
      by: r.by,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async liftRoomBan(hostId: string, uid: string): Promise<void> {
    const res = await this.ctx.col.roomBans.deleteOne({ hostId, userId: uid });
    if (!res.deletedCount) throw notFound('Live ban');
  }

  private briefs(uids: string[]): Promise<Map<string, UserBrief>> {
    return this.ctx.services.users.briefs(uids);
  }
}
