import { randomInt } from 'node:crypto';
import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { z } from 'zod';
import type {
  AgencyAnalytics,
  AgencyAuditAction,
  AgencyAuditRow,
  AgencyDashboard,
  AgencyDay,
  AgencyGiftRow,
  AgencyHostAnalytics,
  AgencyInvitation,
  AgencyLeaderboard,
  AgencyMember,
  AgencyMembership,
  AgencyRole,
  AgencySessionRow,
  AgencySummary,
  TopAgency,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type {
  AgencyDoc,
  AgencyInvitationDoc,
  AgencyMemberDoc,
  AgencyRequestDoc,
} from '../../db/schema.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';
import { addDays, dayKey, monthKey, splitByZonedDay, startOfZonedDay } from '../../lib/time.js';

export const agencyInput = z.object({
  name: z.string().trim().min(2).max(40),
  /** The owner's public short id, or their uid. */
  owner: z.string().trim().min(1).max(128),
  logoUrl: z.url().nullable().default(null),
  commissionRate: z.number().min(0).max(0.5),
});

/** What an owner may change about their own agency. Commission and status are admin-only. */
export const agencyProfileInput = z
  .object({
    name: z.string().trim().min(2).max(40),
    logoUrl: z.url().max(2048).nullable(),
  })
  .partial();

/** Owners upload their logo through the user presign endpoint into this folder. */
export const AGENCY_LOGO_FOLDER = 'agency-logos';

const INVITATION_TTL_DAYS = 7;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RANKING_TTL_MS = 15_000;
const MAX_ANALYTICS_DAYS = 90;

const zeroPeriod = (key: string): AgencyDoc['period'] => ({
  key,
  beans: 0,
  liveSeconds: 0,
  commission: 0,
  gifts: 0,
});

type Counter = 'beans' | 'liveSeconds' | 'commission' | 'gifts';
type Actor = { agency: AgencyDoc; role: 'owner' | 'admin'; uid: string };

export function newAgencyCode(): string {
  let code = 'HA-';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function toAgencySummary(a: AgencyDoc): AgencySummary {
  return {
    id: String(a._id),
    code: a.code,
    name: a.name,
    logoUrl: a.logoUrl,
    memberCount: a.memberCount,
  };
}

/**
 * Host agencies. An agency owner earns a commission on every gift their hosts receive
 * (credited inside the gift transaction). Hosts' beans and live time are tracked per calendar
 * month and per day in the configured timezone, and the agency keeps its own month and
 * lifetime counters, moved in the same transaction as the member's. The monthly reset
 * archives each member's period into `agency_periods` exactly once.
 *
 * Who may do what: the owner runs everything; agency admins (members with `role: 'admin'`)
 * handle requests, invitations and plain hosts; hosts join only with their own consent (an
 * application they send, or an invitation they accept). A locked host cannot leave on their
 * own, and only a platform admin can unlock them.
 */
export class AgenciesService {
  private ranking: { at: number; key: string; rows: AgencyDoc[] } | null = null;

  constructor(private readonly ctx: Ctx) {}

  private get tz() {
    return this.ctx.env.AGENCY_RESET_TIMEZONE;
  }

  currentPeriodKey(): string {
    return monthKey(this.ctx.clock.now(), this.tz);
  }

  private todayKey(): string {
    return dayKey(this.ctx.clock.now(), this.tz);
  }

  async get(id: ObjectId): Promise<AgencyDoc> {
    const a = await this.ctx.col.agencies.findOne({ _id: id });
    if (!a) throw notFound('Agency');
    return a;
  }

  async byOwner(ownerId: string): Promise<AgencyDoc | null> {
    return this.ctx.col.agencies.findOne({ ownerId });
  }

  /** The agency `uid` manages, as its owner or one of its admins. */
  async actor(uid: string): Promise<Actor> {
    const owned = await this.byOwner(uid);
    if (owned) return { agency: owned, role: 'owner', uid };
    const member = await this.ctx.col.agencyMembers.findOne({ userId: uid, role: 'admin' });
    if (member) return { agency: await this.get(member.agencyId), role: 'admin', uid };
    throw forbidden('You do not manage an agency');
  }

  private assertOwner(actor: Actor): void {
    if (actor.role !== 'owner') throw forbidden('Only the agency owner can do this');
  }

  private async memberOf(agencyId: ObjectId, uid: string): Promise<AgencyMemberDoc> {
    const member = await this.ctx.col.agencyMembers.findOne({ agencyId, userId: uid });
    if (!member) throw notFound('Member');
    return member;
  }

  /** Current-period counters, treating a stale period as zero. */
  private period(a: AgencyDoc): AgencyDoc['period'] {
    const key = this.currentPeriodKey();
    return a.period?.key === key ? a.period : zeroPeriod(key);
  }

  // ── Agencies ────────────────────────────────────────────────────────────────

  async create(input: z.infer<typeof agencyInput>, actorId: string): Promise<AgencyDoc> {
    const owner = await this.ctx.services.users.resolve(input.owner);
    if (await this.ctx.col.agencyMembers.findOne({ userId: owner._id }))
      throw conflict('This user is a host in another agency; remove them from it first');
    const now = this.ctx.clock.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc: AgencyDoc = {
        _id: new ObjectId(),
        code: newAgencyCode(),
        name: input.name,
        ownerId: owner._id,
        logoUrl: input.logoUrl,
        commissionRate: input.commissionRate,
        status: 'active',
        memberCount: 0,
        period: zeroPeriod(this.currentPeriodKey()),
        lifetime: { beans: 0, liveSeconds: 0, commission: 0, gifts: 0 },
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.ctx.col.agencies.insertOne(doc);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        if (await this.byOwner(owner._id)) throw conflict('This user already owns an agency');
        continue; // agency code collision: draw another
      }
      this.ranking = null;
      await this.audit(doc._id, actorId, 'agency_created', owner._id, { name: doc.name });
      void this.ctx.services.notifications
        .notify(owner._id, {
          type: 'agency',
          title: 'Your agency is ready',
          body: `You now own ${doc.name}. Invite hosts from the Host agency screen.`,
          data: { kind: 'created', agencyId: String(doc._id) },
        })
        .catch(() => undefined);
      return doc;
    }
    throw conflict('Could not allocate an agency code, retry');
  }

  async update(
    id: ObjectId,
    patch: Partial<Pick<AgencyDoc, 'name' | 'logoUrl' | 'commissionRate' | 'status'>>,
    actorId: string,
  ): Promise<AgencyDoc> {
    const before = await this.get(id);
    const res = await this.ctx.col.agencies.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: this.ctx.clock.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Agency');
    this.ranking = null;
    const statusChanged = patch.status && patch.status !== before.status;
    const action: AgencyAuditAction = statusChanged
      ? patch.status === 'suspended'
        ? 'agency_suspended'
        : 'agency_reactivated'
      : 'agency_updated';
    await this.audit(id, actorId, action, null, { ...patch });
    return res;
  }

  /** The owner edits their agency's public profile (name and logo). */
  async updateProfile(uid: string, patch: z.infer<typeof agencyProfileInput>): Promise<AgencyDoc> {
    const actor = await this.actor(uid);
    this.assertOwner(actor);
    const $set: Partial<AgencyDoc> = {};
    if (patch.name !== undefined)
      $set.name = await this.ctx.services.moderation.assertClean(patch.name, 'name');
    if (patch.logoUrl !== undefined) {
      if (
        patch.logoUrl !== null &&
        patch.logoUrl !== actor.agency.logoUrl &&
        !(await this.ctx.storage.isOwnUpload(patch.logoUrl, AGENCY_LOGO_FOLDER, uid))
      )
        throw badRequest('Upload the logo first');
      $set.logoUrl = patch.logoUrl;
    }
    if (!Object.keys($set).length) return actor.agency;
    return this.update(actor.agency._id, $set, uid);
  }

  async list(filter: { q?: string; status?: AgencyDoc['status'] }, page: number, pageSize: number) {
    const q: Filter<AgencyDoc> = {};
    if (filter.status) q.status = filter.status;
    if (filter.q) {
      const term = filter.q.trim();
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      q.$or = [{ code: term.toUpperCase() }, { name: { $regex: escaped, $options: 'i' } }];
    }
    const [items, total] = await Promise.all([
      this.ctx.col.agencies
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.agencies.countDocuments(q),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Active agencies ranked by this month's host beans, then size, then age. New agencies
   * appear straight away with zero. Kept in memory briefly: it backs the home screen.
   */
  private async rankedAgencies(): Promise<AgencyDoc[]> {
    const key = this.currentPeriodKey();
    const now = this.ctx.clock.now().getTime();
    if (this.ranking && this.ranking.key === key && now - this.ranking.at < RANKING_TTL_MS)
      return this.ranking.rows;
    const rows = await this.ctx.col.agencies
      .aggregate<AgencyDoc>([
        { $match: { status: 'active' } },
        {
          $addFields: {
            _rankBeans: { $cond: [{ $eq: ['$period.key', key] }, '$period.beans', 0] },
          },
        },
        { $sort: { _rankBeans: -1, memberCount: -1, createdAt: 1, _id: 1 } },
        { $project: { _rankBeans: 0 } },
      ])
      .toArray();
    this.ranking = { at: now, key, rows };
    return rows;
  }

  async top(limit: number): Promise<TopAgency[]> {
    const rows = await this.rankedAgencies();
    return rows.slice(0, limit).map((a, i) => ({
      ...toAgencySummary(a),
      rank: i + 1,
      periodBeans: this.period(a).beans,
    }));
  }

  async rankOf(agencyId: ObjectId): Promise<number | null> {
    const idx = (await this.rankedAgencies()).findIndex((a) => a._id.equals(agencyId));
    return idx < 0 ? null : idx + 1;
  }

  // ── Membership ──────────────────────────────────────────────────────────────

  /**
   * Add a host inside `session`. Cancels the user's other pending applications and
   * invitations, so they never linger once the user has an agency.
   */
  private async addMemberIn(
    session: ClientSession,
    agency: AgencyDoc,
    userId: string,
    actorId: string,
    via: 'admin' | 'request' | 'invitation',
  ): Promise<void> {
    if (agency.status !== 'active') throw forbidden('Agency is suspended');
    if (agency.ownerId === userId) throw badRequest('The owner cannot be a member host');
    if (await this.ctx.col.agencies.findOne({ ownerId: userId }, { session }))
      throw conflict('Agency owners cannot join another agency');
    const now = this.ctx.clock.now();
    await this.ctx.col.agencyMembers.insertOne(
      {
        agencyId: agency._id,
        userId,
        role: 'host',
        locked: false,
        dailyTargetMinutes: null,
        joinedAt: now,
        periodKey: this.currentPeriodKey(),
        periodBeans: 0,
        periodLiveSeconds: 0,
        lifetimeBeans: 0,
        lifetimeLiveSeconds: 0,
      },
      { session },
    );
    await this.ctx.col.users.updateOne(
      { _id: userId },
      { $set: { agencyId: agency._id } },
      { session },
    );
    await this.ctx.col.agencies.updateOne(
      { _id: agency._id },
      { $inc: { memberCount: 1 } },
      { session },
    );
    await this.ctx.col.agencyRequests.updateMany(
      { userId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: now } },
      { session },
    );
    await this.ctx.col.agencyInvitations.updateMany(
      { userId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: now } },
      { session },
    );
    await this.audit(agency._id, actorId, 'host_added', userId, { via }, session);
  }

  private async withMembershipTx(fn: (session: ClientSession) => Promise<void>): Promise<void> {
    try {
      await this.ctx.db.withTransaction(fn);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('User already belongs to an agency');
      throw err;
    }
  }

  /** Platform admin: add a host by short id or uid. */
  async addMember(agencyId: ObjectId, identifier: string, actorId: string): Promise<string> {
    const agency = await this.get(agencyId);
    const user = await this.ctx.services.users.resolve(identifier);
    await this.withMembershipTx((session) =>
      this.addMemberIn(session, agency, user._id, actorId, 'admin'),
    );
    return user._id;
  }

  /** Remove a membership. `actorId` is the remover; equal to `userId` when the host left. */
  async removeMember(userId: string, actorId: string = userId): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      const member = await this.ctx.col.agencyMembers.findOneAndDelete({ userId }, { session });
      if (!member) throw notFound('Agency membership');
      await this.ctx.col.users.updateOne(
        { _id: userId },
        { $set: { agencyId: null } },
        { session },
      );
      await this.ctx.col.agencies.updateOne(
        { _id: member.agencyId },
        { $inc: { memberCount: -1 } },
        { session },
      );
      await this.audit(
        member.agencyId,
        actorId,
        actorId === userId ? 'host_left' : 'host_removed',
        userId,
        {},
        session,
      );
    });
  }

  /** A host leaves on their own. Refused while the owner has locked them in. */
  async leave(uid: string): Promise<void> {
    const member = await this.ctx.col.agencyMembers.findOne({ userId: uid });
    if (!member) throw notFound('Agency membership');
    if (member.locked)
      throw new AppError(
        403,
        'agency_locked',
        'Your agency has locked your membership. Contact support to be unlocked.',
      );
    await this.removeMember(uid);
  }

  /** Owner or agency admin removes a host. Admins can't remove the other admins. */
  async removeByManager(actorUid: string, targetUid: string): Promise<void> {
    const actor = await this.actor(actorUid);
    const member = await this.memberOf(actor.agency._id, targetUid);
    if (member.role === 'admin' && actor.role !== 'owner')
      throw forbidden('Only the owner can remove an agency admin');
    if (targetUid === actorUid) throw badRequest('Use "leave agency" instead');
    await this.removeMember(targetUid, actorUid);
  }

  async setRole(actorUid: string, targetUid: string, role: AgencyRole): Promise<void> {
    const actor = await this.actor(actorUid);
    this.assertOwner(actor);
    const member = await this.memberOf(actor.agency._id, targetUid);
    if (member.role === role) return;
    await this.ctx.db.withTransaction(async (session) => {
      await this.ctx.col.agencyMembers.updateOne(
        { _id: member._id },
        { $set: { role } },
        { session },
      );
      await this.audit(
        actor.agency._id,
        actorUid,
        role === 'admin' ? 'admin_promoted' : 'admin_demoted',
        targetUid,
        {},
        session,
      );
    });
  }

  /** Owner locks a host into the agency. There is deliberately no owner-side unlock. */
  async lock(actorUid: string, targetUid: string): Promise<void> {
    const actor = await this.actor(actorUid);
    this.assertOwner(actor);
    const member = await this.memberOf(actor.agency._id, targetUid);
    if (member.locked) return;
    await this.ctx.db.withTransaction(async (session) => {
      await this.ctx.col.agencyMembers.updateOne(
        { _id: member._id },
        { $set: { locked: true } },
        { session },
      );
      await this.audit(actor.agency._id, actorUid, 'host_locked', targetUid, {}, session);
    });
  }

  /** Platform admin only. */
  async unlock(adminUid: string, targetUid: string): Promise<void> {
    const member = await this.ctx.col.agencyMembers.findOne({ userId: targetUid });
    if (!member) throw notFound('Agency membership');
    if (!member.locked) return;
    await this.ctx.db.withTransaction(async (session) => {
      await this.ctx.col.agencyMembers.updateOne(
        { _id: member._id },
        { $set: { locked: false } },
        { session },
      );
      await this.audit(member.agencyId, adminUid, 'host_unlocked', targetUid, {}, session);
    });
  }

  async setDailyTarget(actorUid: string, targetUid: string, minutes: number | null) {
    const actor = await this.actor(actorUid);
    this.assertOwner(actor);
    const member = await this.memberOf(actor.agency._id, targetUid);
    await this.ctx.db.withTransaction(async (session) => {
      await this.ctx.col.agencyMembers.updateOne(
        { _id: member._id },
        { $set: { dailyTargetMinutes: minutes } },
        { session },
      );
      await this.audit(
        actor.agency._id,
        actorUid,
        'target_updated',
        targetUid,
        { minutes },
        session,
      );
    });
  }

  async membership(uid: string): Promise<AgencyMembership | null> {
    const member = await this.ctx.col.agencyMembers.findOne({ userId: uid });
    if (!member) return null;
    const agency = await this.ctx.col.agencies.findOne({ _id: member.agencyId });
    if (!agency) return null;
    return {
      agency: toAgencySummary(agency),
      role: member.role ?? 'host',
      locked: Boolean(member.locked),
      joinedAt: member.joinedAt.toISOString(),
    };
  }

  // ── Applications (host → agency) ─────────────────────────────────────────────

  async requestToJoin(userId: string, agencyId: ObjectId): Promise<void> {
    const agency = await this.get(agencyId);
    if (agency.status !== 'active') throw forbidden('Agency is not accepting hosts');
    if (await this.ctx.col.agencyMembers.findOne({ userId }))
      throw conflict('You already belong to an agency');
    if (await this.byOwner(userId)) throw conflict('Agency owners cannot join another agency');
    try {
      await this.ctx.col.agencyRequests.insertOne({
        agencyId,
        userId,
        status: 'pending',
        createdAt: this.ctx.clock.now(),
        decidedAt: null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('You already have a pending request');
      throw err;
    }
    await this.audit(agencyId, userId, 'request_submitted', userId);
    void this.ctx.services.notifications
      .notify(agency.ownerId, {
        type: 'agency',
        title: 'New host application',
        body: 'A host wants to join your agency',
        data: { kind: 'request', userId },
      })
      .catch(() => undefined);
  }

  async decideRequest(actorUid: string, requestId: ObjectId, approve: boolean): Promise<void> {
    const { agency } = await this.actor(actorUid);
    let req: AgencyRequestDoc | null = null;
    await this.withMembershipTx(async (session) => {
      req = await this.ctx.col.agencyRequests.findOneAndUpdate(
        { _id: requestId, agencyId: agency._id, status: 'pending' },
        { $set: { status: approve ? 'approved' : 'rejected', decidedAt: this.ctx.clock.now() } },
        { returnDocument: 'after', session },
      );
      if (!req) throw notFound('Pending request');
      await this.audit(
        agency._id,
        actorUid,
        approve ? 'request_approved' : 'request_rejected',
        req.userId,
        {},
        session,
      );
      if (approve) await this.addMemberIn(session, agency, req.userId, actorUid, 'request');
    });
    const decided = req as AgencyRequestDoc | null;
    if (!decided) return;
    void this.ctx.services.notifications
      .notify(decided.userId, {
        type: 'agency',
        title: approve ? 'Welcome to the agency' : 'Agency application declined',
        body: approve ? `You joined ${agency.name}` : `${agency.name} declined your application`,
        data: { kind: 'request', agencyId: String(agency._id) },
      })
      .catch(() => undefined);
  }

  async pendingRequests(actorUid: string) {
    const { agency } = await this.actor(actorUid);
    const rows = await this.ctx.col.agencyRequests
      .find({ agencyId: agency._id, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      id: String(r._id),
      user: briefs.get(r.userId) ?? null,
      createdAt: r.createdAt,
    }));
  }

  // ── Invitations (agency → host) ──────────────────────────────────────────────

  private async expireInvitations(filter: Filter<AgencyInvitationDoc>): Promise<void> {
    await this.ctx.col.agencyInvitations.updateMany(
      { ...filter, status: 'pending', expiresAt: { $lte: this.ctx.clock.now() } },
      { $set: { status: 'expired' } },
    );
  }

  private async toInvitations(rows: AgencyInvitationDoc[]): Promise<AgencyInvitation[]> {
    const agencyIds = [...new Set(rows.map((r) => String(r.agencyId)))].map(
      (id) => new ObjectId(id),
    );
    const [agencies, briefs] = await Promise.all([
      this.ctx.col.agencies.find({ _id: { $in: agencyIds } }).toArray(),
      this.ctx.services.users.briefs(rows.flatMap((r) => [r.userId, r.invitedBy])),
    ]);
    const byId = new Map(agencies.map((a) => [String(a._id), a]));
    return rows.flatMap((r) => {
      const agency = byId.get(String(r.agencyId));
      if (!agency) return [];
      return [
        {
          id: String(r._id),
          agency: toAgencySummary(agency),
          user: briefs.get(r.userId) ?? null,
          invitedBy: briefs.get(r.invitedBy) ?? null,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
        },
      ];
    });
  }

  async invite(actorUid: string, identifier: string): Promise<AgencyInvitation> {
    const { agency } = await this.actor(actorUid);
    if (agency.status !== 'active') throw forbidden('Agency is suspended');
    const user = await this.ctx.services.users.resolve(identifier);
    if (user._id === agency.ownerId) throw badRequest('You own this agency');
    if (await this.ctx.col.agencyMembers.findOne({ userId: user._id }))
      throw conflict('This user already belongs to an agency');
    if (await this.byOwner(user._id)) throw conflict('Agency owners cannot join another agency');
    await this.expireInvitations({ agencyId: agency._id, userId: user._id });
    const now = this.ctx.clock.now();
    const doc: AgencyInvitationDoc = {
      _id: new ObjectId(),
      agencyId: agency._id,
      userId: user._id,
      invitedBy: actorUid,
      status: 'pending',
      createdAt: now,
      expiresAt: addDays(now, INVITATION_TTL_DAYS),
      decidedAt: null,
    };
    try {
      await this.ctx.col.agencyInvitations.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('This user already has a pending invitation');
      throw err;
    }
    await this.audit(agency._id, actorUid, 'host_invited', user._id);
    void this.ctx.services.notifications
      .notify(user._id, {
        type: 'agency',
        title: 'Agency invitation',
        body: `${agency.name} invited you to join as a host`,
        data: { kind: 'invitation', invitationId: String(doc._id), agencyId: String(agency._id) },
      })
      .catch(() => undefined);
    const [out] = await this.toInvitations([doc]);
    return out!;
  }

  async agencyInvitations(actorUid: string): Promise<AgencyInvitation[]> {
    const { agency } = await this.actor(actorUid);
    await this.expireInvitations({ agencyId: agency._id });
    const rows = await this.ctx.col.agencyInvitations
      .find({ agencyId: agency._id, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return this.toInvitations(rows);
  }

  async cancelInvitation(actorUid: string, invitationId: ObjectId): Promise<void> {
    const { agency } = await this.actor(actorUid);
    const res = await this.ctx.col.agencyInvitations.findOneAndUpdate(
      { _id: invitationId, agencyId: agency._id, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: this.ctx.clock.now() } },
    );
    if (!res) throw notFound('Pending invitation');
    await this.audit(agency._id, actorUid, 'invite_cancelled', res.userId);
  }

  async myInvitations(uid: string): Promise<AgencyInvitation[]> {
    await this.expireInvitations({ userId: uid });
    const rows = await this.ctx.col.agencyInvitations
      .find({ userId: uid, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return this.toInvitations(rows);
  }

  async respondInvitation(uid: string, invitationId: ObjectId, accept: boolean): Promise<void> {
    let agency: AgencyDoc | null = null;
    await this.withMembershipTx(async (session) => {
      const inv = await this.ctx.col.agencyInvitations.findOneAndUpdate(
        {
          _id: invitationId,
          userId: uid,
          status: 'pending',
          expiresAt: { $gt: this.ctx.clock.now() },
        },
        { $set: { status: accept ? 'accepted' : 'declined', decidedAt: this.ctx.clock.now() } },
        { returnDocument: 'after', session },
      );
      if (!inv) throw notFound('Pending invitation');
      agency = await this.ctx.col.agencies.findOne({ _id: inv.agencyId }, { session });
      if (!agency) throw notFound('Agency');
      await this.audit(
        agency._id,
        uid,
        accept ? 'invite_accepted' : 'invite_declined',
        uid,
        {},
        session,
      );
      if (accept) await this.addMemberIn(session, agency, uid, uid, 'invitation');
    });
    const joined = agency as AgencyDoc | null;
    if (!joined) return;
    void this.ctx.services.notifications
      .notify(joined.ownerId, {
        type: 'agency',
        title: accept ? 'Invitation accepted' : 'Invitation declined',
        body: accept ? 'A host accepted your invitation' : 'A host declined your invitation',
        data: { kind: 'invitation', userId: uid },
      })
      .catch(() => undefined);
  }

  // ── Dashboard reads ──────────────────────────────────────────────────────────

  async members(agencyId: ObjectId): Promise<AgencyMember[]> {
    const rows = await this.ctx.col.agencyMembers
      .find({ agencyId })
      .sort({ periodBeans: -1 })
      .limit(1000)
      .toArray();
    const uids = rows.map((r) => r.userId);
    const now = this.ctx.clock.now();
    const today = this.todayKey();
    const [briefs, todayRows, liveRooms] = await Promise.all([
      this.ctx.services.users.briefs(uids),
      this.ctx.col.agencyDailyStats.find({ agencyId, dayKey: today }).toArray(),
      this.ctx.col.liveRooms
        .find(
          { hostId: { $in: uids }, status: 'live' },
          { projection: { hostId: 1, startedAt: 1 } },
        )
        .toArray(),
    ]);
    const todayBy = new Map(todayRows.map((r) => [r.userId, r]));
    const dayStart = startOfZonedDay(now, this.tz);
    const liveSecondsBy = new Map(
      liveRooms.map((r) => {
        const from = r.startedAt > dayStart ? r.startedAt : dayStart;
        return [r.hostId, Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000))];
      }),
    );
    const current = this.currentPeriodKey();
    const roleOrder = (m: AgencyMemberDoc) => (m.role === 'admin' ? 0 : 1);
    return rows
      .map((r) => {
        const fresh = r.periodKey === current;
        return {
          doc: r,
          out: {
            user: briefs.get(r.userId) ?? null,
            role: r.role ?? 'host',
            locked: Boolean(r.locked),
            dailyTargetMinutes: r.dailyTargetMinutes ?? null,
            joinedAt: r.joinedAt.toISOString(),
            // A member whose period has not been rolled yet has earned nothing this month.
            periodBeans: fresh ? r.periodBeans : 0,
            periodLiveSeconds: fresh ? r.periodLiveSeconds : 0,
            lifetimeBeans: r.lifetimeBeans ?? 0,
            lifetimeLiveSeconds: r.lifetimeLiveSeconds ?? 0,
            todayBeans: todayBy.get(r.userId)?.beans ?? 0,
            todayLiveSeconds:
              (todayBy.get(r.userId)?.liveSeconds ?? 0) + (liveSecondsBy.get(r.userId) ?? 0),
            isLive: liveSecondsBy.has(r.userId),
          } satisfies AgencyMember,
        };
      })
      .sort((a, b) => roleOrder(a.doc) - roleOrder(b.doc) || b.out.periodBeans - a.out.periodBeans)
      .map((x) => x.out);
  }

  async dashboard(uid: string): Promise<AgencyDashboard> {
    const actor = await this.actor(uid);
    const { agency } = actor;
    const period = this.period(agency);
    const now = this.ctx.clock.now();
    const [todayAgg, liveNow, pendingRequests, pendingInvitations, rank] = await Promise.all([
      this.ctx.col.agencyDailyStats
        .aggregate<{ beans: number; liveSeconds: number }>([
          { $match: { agencyId: agency._id, dayKey: this.todayKey() } },
          {
            $group: { _id: null, beans: { $sum: '$beans' }, liveSeconds: { $sum: '$liveSeconds' } },
          },
        ])
        .toArray(),
      this.ctx.col.users.countDocuments({
        agencyId: agency._id,
        liveRoomId: { $type: 'objectId' },
      }),
      this.ctx.col.agencyRequests.countDocuments({ agencyId: agency._id, status: 'pending' }),
      this.ctx.col.agencyInvitations.countDocuments({
        agencyId: agency._id,
        status: 'pending',
        expiresAt: { $gt: now },
      }),
      agency.status === 'active' ? this.rankOf(agency._id) : Promise.resolve(null),
    ]);
    return {
      agency: {
        ...toAgencySummary(agency),
        ownerId: agency.ownerId,
        commissionRate: agency.commissionRate,
        status: agency.status,
        createdAt: agency.createdAt.toISOString(),
      },
      role: actor.role,
      rank,
      periodKey: period.key,
      totals: {
        members: agency.memberCount,
        periodBeans: period.beans,
        periodLiveSeconds: period.liveSeconds,
        periodCommission: period.commission,
        periodGifts: period.gifts,
        lifetimeBeans: agency.lifetime?.beans ?? 0,
        lifetimeCommission: agency.lifetime?.commission ?? 0,
        todayBeans: todayAgg[0]?.beans ?? 0,
        todayLiveSeconds: todayAgg[0]?.liveSeconds ?? 0,
        liveNow,
      },
      pendingRequests,
      pendingInvitations,
    };
  }

  async managedMembers(uid: string): Promise<AgencyMember[]> {
    const { agency } = await this.actor(uid);
    return this.members(agency._id);
  }

  /** Day keys for the last `days` days, oldest first, ending today (agency timezone). */
  private lastDayKeys(days: number): string[] {
    const start = startOfZonedDay(this.ctx.clock.now(), this.tz).getTime();
    const keys: string[] = [];
    // Midday of each day is always inside it, whatever the DST shift.
    for (let i = days - 1; i >= 0; i--)
      keys.push(dayKey(new Date(start - i * 86_400_000 + 12 * 3_600_000), this.tz));
    return keys;
  }

  private async dailySeries(
    filter: { agencyId: ObjectId; userId?: string },
    days: number,
  ): Promise<AgencyAnalytics> {
    const n = Math.min(Math.max(days, 1), MAX_ANALYTICS_DAYS);
    const keys = this.lastDayKeys(n);
    const rows = await this.ctx.col.agencyDailyStats
      .aggregate<AgencyDay & { _id: string }>([
        { $match: { ...filter, dayKey: { $gte: keys[0]!, $lte: keys.at(-1)! } } },
        {
          $group: {
            _id: '$dayKey',
            beans: { $sum: '$beans' },
            gifts: { $sum: '$gifts' },
            commission: { $sum: '$commission' },
            liveSeconds: { $sum: '$liveSeconds' },
            activeHosts: {
              $sum: {
                $cond: [{ $or: [{ $gt: ['$beans', 0] }, { $gt: ['$liveSeconds', 0] }] }, 1, 0],
              },
            },
          },
        },
      ])
      .toArray();
    const byDay = new Map(rows.map((r) => [r._id, r]));
    const daily = keys.map((k) => {
      const r = byDay.get(k);
      const day: AgencyDay = {
        dayKey: k,
        beans: r?.beans ?? 0,
        gifts: r?.gifts ?? 0,
        commission: r?.commission ?? 0,
        liveSeconds: r?.liveSeconds ?? 0,
      };
      if (!filter.userId) day.activeHosts = r?.activeHosts ?? 0;
      return day;
    });
    const totals = daily.reduce(
      (t, d) => ({
        beans: t.beans + d.beans,
        gifts: t.gifts + d.gifts,
        commission: t.commission + d.commission,
        liveSeconds: t.liveSeconds + d.liveSeconds,
      }),
      { beans: 0, gifts: 0, commission: 0, liveSeconds: 0 },
    );
    return { days: n, totals, daily };
  }

  async analytics(uid: string, days: number): Promise<AgencyAnalytics> {
    const { agency } = await this.actor(uid);
    return this.dailySeries({ agencyId: agency._id }, days);
  }

  async hostAnalytics(uid: string, hostUid: string, days: number): Promise<AgencyHostAnalytics> {
    const { agency } = await this.actor(uid);
    const memberDoc = await this.memberOf(agency._id, hostUid);
    const series = await this.dailySeries({ agencyId: agency._id, userId: hostUid }, days);
    const since = addDays(this.ctx.clock.now(), -series.days);
    const [members, sessions] = await Promise.all([
      this.members(agency._id),
      this.ctx.col.liveRooms.countDocuments({
        hostId: hostUid,
        startedAt: { $gte: since > memberDoc.joinedAt ? since : memberDoc.joinedAt },
      }),
    ]);
    const member = members.find((m) => m.user?.id === hostUid);
    if (!member) throw notFound('Member');
    return { ...series, member, sessions };
  }

  async hostGifts(
    uid: string,
    hostUid: string,
    opts: { cursor?: string; limit: number },
  ): Promise<{ items: AgencyGiftRow[]; nextCursor: string | null }> {
    const { agency } = await this.actor(uid);
    await this.memberOf(agency._id, hostUid);
    const rows = await this.ctx.col.giftTransactions
      .find({
        receivers: { $elemMatch: { userId: hostUid, agencyId: agency._id } },
        ...afterCursor(opts.cursor),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const senders = await this.ctx.services.users.briefs(page.map((r) => r.senderId));
    const last = page.at(-1);
    return {
      items: page.map((t) => {
        const r = t.receivers.find((x) => x.userId === hostUid)!;
        return {
          id: String(t._id),
          sender: senders.get(t.senderId) ?? null,
          giftName: t.giftName,
          quantity: t.quantity,
          cost: r.cost,
          beans: r.beans,
          commission: r.agencyFee,
          createdAt: t.createdAt.toISOString(),
        };
      }),
      nextCursor:
        rows.length > opts.limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  async hostSessions(
    uid: string,
    hostUid: string,
    opts: { cursor?: string; limit: number },
  ): Promise<{ items: AgencySessionRow[]; nextCursor: string | null }> {
    const { agency } = await this.actor(uid);
    const member = await this.memberOf(agency._id, hostUid);
    const rows = await this.ctx.col.liveRooms
      .find({
        hostId: hostUid,
        startedAt: { $gte: member.joinedAt },
        ...afterCursor(opts.cursor, 'startedAt'),
      })
      .sort({ startedAt: -1, _id: -1 })
      .limit(opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const now = this.ctx.clock.now();
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r._id),
        type: r.type,
        title: r.title,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        durationSec: Math.max(
          0,
          Math.round(((r.endedAt ?? now).getTime() - r.startedAt.getTime()) / 1000),
        ),
        giftBeans: r.giftBeans,
        peakViewers: r.peakViewers,
      })),
      nextCursor:
        rows.length > opts.limit && last ? encodeCursor(last.startedAt, String(last._id)) : null,
    };
  }

  async leaderboard(uid: string, periodKey?: string): Promise<AgencyLeaderboard> {
    const { agency } = await this.actor(uid);
    const current = this.currentPeriodKey();
    const key = periodKey ?? current;
    const past = (await this.ctx.col.agencyPeriods.distinct('periodKey', {
      agencyId: agency._id,
    })) as string[];
    const periods = [
      current,
      ...past
        .filter((p) => p !== current)
        .sort()
        .reverse(),
    ].slice(0, 12);
    let rows: { userId: string; beans: number; liveSeconds: number }[];
    if (key === current) {
      rows = (
        await this.ctx.col.agencyMembers
          .find({ agencyId: agency._id, periodKey: current })
          .sort({ periodBeans: -1 })
          .limit(100)
          .toArray()
      ).map((m) => ({ userId: m.userId, beans: m.periodBeans, liveSeconds: m.periodLiveSeconds }));
    } else {
      rows = await this.ctx.col.agencyPeriods
        .find({ agencyId: agency._id, periodKey: key })
        .sort({ beans: -1 })
        .limit(100)
        .toArray();
    }
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return {
      periodKey: key,
      periods,
      items: rows.map((r, i) => ({
        rank: i + 1,
        user: briefs.get(r.userId) ?? null,
        beans: r.beans,
        liveSeconds: r.liveSeconds,
      })),
    };
  }

  async auditLog(
    agencyId: ObjectId,
    opts: { cursor?: string; limit: number },
  ): Promise<{ items: AgencyAuditRow[]; nextCursor: string | null }> {
    const rows = await this.ctx.col.agencyAudit
      .find({ agencyId, ...afterCursor(opts.cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const briefs = await this.ctx.services.users.briefs(
      page.flatMap((r) => (r.targetUserId ? [r.actorId, r.targetUserId] : [r.actorId])),
    );
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r._id),
        action: r.action,
        actor: briefs.get(r.actorId) ?? null,
        target: r.targetUserId ? (briefs.get(r.targetUserId) ?? null) : null,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > opts.limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  async managedAuditLog(uid: string, opts: { cursor?: string; limit: number }) {
    const { agency } = await this.actor(uid);
    return this.auditLog(agency._id, opts);
  }

  async history(agencyId: ObjectId, periodKey?: string) {
    return this.ctx.col.agencyPeriods
      .find({ agencyId, ...(periodKey ? { periodKey } : {}) })
      .sort({ periodKey: -1, beans: -1 })
      .limit(1000)
      .toArray();
  }

  private async audit(
    agencyId: ObjectId,
    actorId: string,
    action: AgencyAuditAction,
    targetUserId: string | null = null,
    meta: Record<string, unknown> = {},
    session?: ClientSession,
  ): Promise<void> {
    await this.ctx.col.agencyAudit.insertOne(
      {
        _id: new ObjectId(),
        agencyId,
        actorId,
        action,
        targetUserId,
        meta,
        createdAt: this.ctx.clock.now(),
      },
      session ? { session } : {},
    );
  }

  // ── Accounting ─────────────────────────────────────────────────────────────

  /** Called inside the gift transaction, once per receiving host. */
  async recordEarnings(
    session: ClientSession,
    e: {
      agencyId: ObjectId;
      userId: string;
      beans: number;
      commission: number;
      gifts: number;
      periodKey: string;
      at: Date;
    },
  ): Promise<void> {
    await this.bumpMember(session, e.agencyId, e.userId, e.periodKey, {
      periodBeans: e.beans,
      lifetimeBeans: e.beans,
    });
    await this.bumpDay(session, e.agencyId, e.userId, dayKey(e.at, this.tz), {
      beans: e.beans,
      gifts: e.gifts,
      commission: e.commission,
    });
    await this.bumpAgency(session, e.agencyId, e.periodKey, {
      beans: e.beans,
      gifts: e.gifts,
      commission: e.commission,
    });
  }

  /** A host's live session [from, to) ended. Split per day; the month is that of `to`. */
  async recordLiveTime(agencyId: ObjectId, userId: string, from: Date, to: Date): Promise<void> {
    const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
    if (seconds <= 0) return;
    const periodKey = monthKey(to, this.tz);
    await this.ctx.db.withTransaction(async (session) => {
      await this.bumpMember(session, agencyId, userId, periodKey, {
        periodLiveSeconds: seconds,
        lifetimeLiveSeconds: seconds,
      });
      for (const d of splitByZonedDay(from, to, this.tz))
        await this.bumpDay(session, agencyId, userId, d.dayKey, { liveSeconds: d.seconds });
      await this.bumpAgency(session, agencyId, periodKey, { liveSeconds: seconds });
    });
  }

  private async bumpDay(
    session: ClientSession,
    agencyId: ObjectId,
    userId: string,
    day: string,
    inc: Partial<Record<Counter, number>>,
  ): Promise<void> {
    await this.ctx.col.agencyDailyStats.updateOne(
      { agencyId, userId, dayKey: day },
      {
        $inc: {
          beans: inc.beans ?? 0,
          gifts: inc.gifts ?? 0,
          commission: inc.commission ?? 0,
          liveSeconds: inc.liveSeconds ?? 0,
        },
      },
      { upsert: true, session },
    );
  }

  private async bumpAgency(
    session: ClientSession,
    agencyId: ObjectId,
    periodKey: string,
    inc: Partial<Record<Counter, number>>,
  ): Promise<void> {
    const entries = Object.entries(inc).filter(([, v]) => v);
    if (!entries.length) return;
    const lifetime = Object.fromEntries(entries.map(([k, v]) => [`lifetime.${k}`, v]));
    const both = {
      ...lifetime,
      ...Object.fromEntries(entries.map(([k, v]) => [`period.${k}`, v])),
    };
    const col = this.ctx.col.agencies;
    if (
      (await col.updateOne({ _id: agencyId, 'period.key': periodKey }, { $inc: both }, { session }))
        .matchedCount
    )
      return;
    // The agency is still on an older month: roll it forward (never backward), then count.
    await col.updateOne(
      {
        _id: agencyId,
        $or: [{ 'period.key': { $lt: periodKey } }, { period: { $exists: false } }],
      },
      { $set: { period: zeroPeriod(periodKey) } },
      { session },
    );
    const res = await col.updateOne(
      { _id: agencyId, 'period.key': periodKey },
      { $inc: both },
      { session },
    );
    // Already on a newer month (a late write from just before midnight): lifetime only.
    if (!res.matchedCount) await col.updateOne({ _id: agencyId }, { $inc: lifetime }, { session });
  }

  private async bumpMember(
    session: ClientSession,
    agencyId: ObjectId,
    userId: string,
    periodKey: string,
    inc: Partial<
      Record<'periodBeans' | 'periodLiveSeconds' | 'lifetimeBeans' | 'lifetimeLiveSeconds', number>
    >,
  ): Promise<void> {
    const res = await this.ctx.col.agencyMembers.updateOne(
      { agencyId, userId, periodKey },
      { $inc: inc },
      { session },
    );
    if (res.matchedCount) return;
    // The member is still on an old period (reset job has not reached them): roll inline.
    const member = await this.ctx.col.agencyMembers.findOne({ agencyId, userId }, { session });
    if (!member) return; // left the agency mid-flight
    await this.rollMember(session, member, periodKey);
    await this.ctx.col.agencyMembers.updateOne(
      { agencyId, userId, periodKey },
      { $inc: inc },
      { session },
    );
  }

  private async rollMember(
    session: ClientSession,
    member: AgencyMemberDoc,
    newPeriodKey: string,
  ): Promise<void> {
    if (member.periodKey === newPeriodKey) return;
    // $setOnInsert makes the archive write-once: a retried roll can never double-count.
    await this.ctx.col.agencyPeriods.updateOne(
      { agencyId: member.agencyId, periodKey: member.periodKey, userId: member.userId },
      {
        $setOnInsert: {
          agencyId: member.agencyId,
          periodKey: member.periodKey,
          userId: member.userId,
          beans: member.periodBeans,
          liveSeconds: member.periodLiveSeconds,
          closedAt: this.ctx.clock.now(),
        },
      },
      { upsert: true, session },
    );
    await this.ctx.col.agencyMembers.updateOne(
      { _id: member._id, periodKey: member.periodKey },
      { $set: { periodKey: newPeriodKey, periodBeans: 0, periodLiveSeconds: 0 } },
      { session },
    );
  }

  /** Monthly job: roll every member and agency still on an old period. Idempotent. */
  async monthlyReset(): Promise<{ rolled: number }> {
    const periodKey = this.currentPeriodKey();
    let rolled = 0;
    const cursor = this.ctx.col.agencyMembers.find({ periodKey: { $ne: periodKey } });
    for await (const member of cursor) {
      await this.ctx.db.withTransaction((session) => this.rollMember(session, member, periodKey));
      rolled++;
    }
    await this.ctx.col.agencies.updateMany(
      { $or: [{ 'period.key': { $lt: periodKey } }, { period: { $exists: false } }] },
      { $set: { period: zeroPeriod(periodKey) } },
    );
    this.ranking = null;
    return { rolled };
  }
}
