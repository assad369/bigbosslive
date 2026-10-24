import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import type { AgencyDoc, AgencyMemberDoc } from '../../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { monthKey } from '../../lib/time.js';

export const agencyInput = z.object({
  name: z.string().trim().min(2).max(40),
  ownerId: z.string().min(1).max(128),
  logoUrl: z.url().nullable().default(null),
  commissionRate: z.number().min(0).max(0.5),
});

/**
 * Host agencies. An agency owner earns a commission on every gift their hosts receive
 * (credited inside the gift transaction), and hosts' beans and live time are tracked per
 * calendar month in the configured timezone. The monthly reset archives each member's period
 * into `agency_periods` exactly once.
 */
export class AgenciesService {
  constructor(private readonly ctx: Ctx) {}

  currentPeriodKey(): string {
    return monthKey(this.ctx.clock.now(), this.ctx.env.AGENCY_RESET_TIMEZONE);
  }

  async get(id: ObjectId): Promise<AgencyDoc> {
    const a = await this.ctx.col.agencies.findOne({ _id: id });
    if (!a) throw notFound('Agency');
    return a;
  }

  async byOwner(ownerId: string): Promise<AgencyDoc | null> {
    return this.ctx.col.agencies.findOne({ ownerId });
  }

  async create(input: z.infer<typeof agencyInput>): Promise<AgencyDoc> {
    await this.ctx.services.users.get(input.ownerId);
    const now = this.ctx.clock.now();
    const doc: AgencyDoc = {
      _id: new ObjectId(),
      name: input.name,
      ownerId: input.ownerId,
      logoUrl: input.logoUrl,
      commissionRate: input.commissionRate,
      status: 'active',
      memberCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.ctx.col.agencies.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('This user already owns an agency');
      throw err;
    }
    return doc;
  }

  async update(
    id: ObjectId,
    patch: Partial<Pick<AgencyDoc, 'name' | 'logoUrl' | 'commissionRate' | 'status'>>,
  ): Promise<AgencyDoc> {
    const res = await this.ctx.col.agencies.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: this.ctx.clock.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Agency');
    return res;
  }

  async list(filter: { q?: string; status?: AgencyDoc['status'] }, page: number, pageSize: number) {
    const q: Filter<AgencyDoc> = {};
    if (filter.status) q.status = filter.status;
    if (filter.q)
      q.name = { $regex: filter.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
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

  // ── Membership ──────────────────────────────────────────────────────────────

  async addMember(agencyId: ObjectId, userId: string): Promise<void> {
    const agency = await this.get(agencyId);
    if (agency.status !== 'active') throw forbidden('Agency is suspended');
    if (agency.ownerId === userId) throw badRequest('The owner cannot be a member host');
    try {
      await this.ctx.db.withTransaction(async (session) => {
        await this.ctx.col.agencyMembers.insertOne(
          {
            agencyId,
            userId,
            joinedAt: this.ctx.clock.now(),
            periodKey: this.currentPeriodKey(),
            periodBeans: 0,
            periodLiveSeconds: 0,
          },
          { session },
        );
        await this.ctx.col.users.updateOne({ _id: userId }, { $set: { agencyId } }, { session });
        await this.ctx.col.agencies.updateOne(
          { _id: agencyId },
          { $inc: { memberCount: 1 } },
          { session },
        );
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('User already belongs to an agency');
      throw err;
    }
  }

  async removeMember(userId: string): Promise<void> {
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
    });
  }

  async requestToJoin(userId: string, agencyId: ObjectId): Promise<void> {
    const agency = await this.get(agencyId);
    if (agency.status !== 'active') throw forbidden('Agency is not accepting hosts');
    if (await this.ctx.col.agencyMembers.findOne({ userId }))
      throw conflict('You already belong to an agency');
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
    void this.ctx.services.notifications
      .notify(agency.ownerId, {
        type: 'agency',
        title: 'New host application',
        body: 'A host wants to join your agency',
        data: { userId },
      })
      .catch(() => undefined);
  }

  async decideRequest(ownerId: string, requestId: ObjectId, approve: boolean): Promise<void> {
    const agency = await this.byOwner(ownerId);
    if (!agency) throw forbidden('You do not own an agency');
    const req = await this.ctx.col.agencyRequests.findOneAndUpdate(
      { _id: requestId, agencyId: agency._id, status: 'pending' },
      { $set: { status: approve ? 'approved' : 'rejected', decidedAt: this.ctx.clock.now() } },
      { returnDocument: 'after' },
    );
    if (!req) throw notFound('Pending request');
    if (approve) await this.addMember(agency._id, req.userId);
    void this.ctx.services.notifications
      .notify(req.userId, {
        type: 'agency',
        title: approve ? 'Welcome to the agency' : 'Agency application declined',
        body: approve ? `You joined ${agency.name}` : `${agency.name} declined your application`,
        data: { agencyId: String(agency._id) },
      })
      .catch(() => undefined);
  }

  async pendingRequests(ownerId: string) {
    const agency = await this.byOwner(ownerId);
    if (!agency) throw forbidden('You do not own an agency');
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

  async members(agencyId: ObjectId) {
    const rows = await this.ctx.col.agencyMembers
      .find({ agencyId })
      .sort({ periodBeans: -1 })
      .limit(1000)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    const current = this.currentPeriodKey();
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      joinedAt: r.joinedAt,
      periodKey: current,
      // A member whose period has not been rolled yet has earned nothing this month.
      periodBeans: r.periodKey === current ? r.periodBeans : 0,
      periodLiveSeconds: r.periodKey === current ? r.periodLiveSeconds : 0,
    }));
  }

  async ownerDashboard(ownerId: string) {
    const agency = await this.byOwner(ownerId);
    if (!agency) throw forbidden('You do not own an agency');
    const members = await this.members(agency._id);
    return {
      agency,
      totals: {
        members: members.length,
        periodBeans: members.reduce((s, m) => s + m.periodBeans, 0),
        periodLiveSeconds: members.reduce((s, m) => s + m.periodLiveSeconds, 0),
      },
      members,
    };
  }

  async history(agencyId: ObjectId, periodKey?: string) {
    return this.ctx.col.agencyPeriods
      .find({ agencyId, ...(periodKey ? { periodKey } : {}) })
      .sort({ periodKey: -1, beans: -1 })
      .limit(1000)
      .toArray();
  }

  // ── Accounting ─────────────────────────────────────────────────────────────

  /** Called inside the gift transaction. */
  async recordEarnings(
    session: ClientSession,
    agencyId: ObjectId,
    userId: string,
    beans: number,
    periodKey: string,
  ): Promise<void> {
    await this.bump(session, agencyId, userId, periodKey, { periodBeans: beans });
  }

  async recordLiveTime(agencyId: ObjectId, userId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    const periodKey = this.currentPeriodKey();
    await this.ctx.db.withTransaction((session) =>
      this.bump(session, agencyId, userId, periodKey, { periodLiveSeconds: seconds }),
    );
  }

  private async bump(
    session: ClientSession,
    agencyId: ObjectId,
    userId: string,
    periodKey: string,
    inc: Partial<Record<'periodBeans' | 'periodLiveSeconds', number>>,
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

  /** Monthly job: roll every member still on an old period. Idempotent and resumable. */
  async monthlyReset(): Promise<{ rolled: number }> {
    const periodKey = this.currentPeriodKey();
    let rolled = 0;
    const cursor = this.ctx.col.agencyMembers.find({ periodKey: { $ne: periodKey } });
    for await (const member of cursor) {
      await this.ctx.db.withTransaction((session) => this.rollMember(session, member, periodKey));
      rolled++;
    }
    return { rolled };
  }
}
