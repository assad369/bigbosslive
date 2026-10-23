import type { ClientSession, Filter } from 'mongodb';
import { SOCKET, type Currency, type LedgerReason } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LedgerDoc, RechargeDoc, UserDoc } from '../../db/schema.js';
import { badRequest, forbidden, insufficientBalance, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';

const FIELD: Record<Currency, 'wallet.diamonds' | 'wallet.beans' | 'wallet.agentStock'> = {
  diamonds: 'wallet.diamonds',
  beans: 'wallet.beans',
  agent_stock: 'wallet.agentStock',
};

function balanceOf(user: Pick<UserDoc, 'wallet'>, currency: Currency): number {
  return currency === 'diamonds' ? user.wallet.diamonds : currency === 'beans' ? user.wallet.beans : user.wallet.agentStock;
}

export interface Movement {
  uid: string;
  currency: Currency;
  amount: number;
  reason: LedgerReason;
  refId: string | null;
  meta?: Record<string, unknown>;
  /** Extra counters to `$inc` in the same write (e.g. `stats.totalReceived`). */
  inc?: Record<string, number>;
}

/**
 * The only code allowed to change a balance. Every movement is a conditional `$inc` plus a
 * ledger row, both inside the caller's transaction — so balances can never go negative and
 * the ledger always reconciles to the balance.
 */
export class WalletService {
  constructor(private readonly ctx: Ctx) {}

  async debit(session: ClientSession, m: Movement): Promise<number> {
    if (!Number.isSafeInteger(m.amount) || m.amount <= 0) throw badRequest('Amount must be a positive integer');
    const field = FIELD[m.currency];
    const updated = await this.ctx.col.users.findOneAndUpdate(
      { _id: m.uid, status: 'active', [field]: { $gte: m.amount } } as Filter<UserDoc>,
      { $inc: { [field]: -m.amount, ...(m.inc ?? {}) } },
      { session, returnDocument: 'after', projection: { wallet: 1 } },
    );
    if (!updated) {
      const exists = await this.ctx.col.users.findOne({ _id: m.uid }, { session, projection: { status: 1 } });
      if (!exists) throw notFound('User');
      if (exists.status !== 'active') throw forbidden('Account is not active');
      throw insufficientBalance(m.currency === 'agent_stock' ? 'agent stock' : m.currency);
    }
    const balanceAfter = balanceOf(updated, m.currency);
    await this.writeLedger(session, m, -m.amount, balanceAfter);
    return balanceAfter;
  }

  async credit(session: ClientSession, m: Movement): Promise<number> {
    if (!Number.isSafeInteger(m.amount) || m.amount < 0) throw badRequest('Amount must be a non-negative integer');
    const field = FIELD[m.currency];
    const updated = await this.ctx.col.users.findOneAndUpdate(
      { _id: m.uid, status: { $ne: 'deleted' } },
      { $inc: { [field]: m.amount, ...(m.inc ?? {}) } },
      { session, returnDocument: 'after', projection: { wallet: 1 } },
    );
    if (!updated) throw notFound('User');
    const balanceAfter = balanceOf(updated, m.currency);
    if (m.amount > 0) await this.writeLedger(session, m, m.amount, balanceAfter);
    return balanceAfter;
  }

  private async writeLedger(session: ClientSession, m: Movement, delta: number, balanceAfter: number) {
    const row: LedgerDoc = {
      userId: m.uid,
      currency: m.currency,
      delta,
      balanceAfter,
      reason: m.reason,
      refId: m.refId,
      createdAt: this.ctx.clock.now(),
      ...(m.meta ? { meta: m.meta } : {}),
    };
    await this.ctx.col.ledger.insertOne(row, { session });
  }

  async balances(uid: string) {
    const user = await this.ctx.col.users.findOne({ _id: uid }, { projection: { wallet: 1 } });
    if (!user) throw notFound('User');
    return { ...user.wallet };
  }

  async ledger(uid: string, opts: { currency?: Currency; cursor?: string; limit: number }) {
    const q: Filter<LedgerDoc> = { userId: uid, ...afterCursor(opts.cursor) };
    if (opts.currency) q.currency = opts.currency;
    const rows = await this.ctx.col.ledger.find(q).sort({ createdAt: -1, _id: -1 }).limit(opts.limit + 1).toArray();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r._id),
        userId: r.userId,
        currency: r.currency,
        delta: r.delta,
        balanceAfter: r.balanceAfter,
        reason: r.reason,
        refId: r.refId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  /**
   * Credit a recharge. Recharged diamonds are the only diamonds that earn level points 1:1,
   * so the level is recalculated inside the same transaction. Idempotent on `idempotencyKey`.
   */
  async recharge(input: {
    uid: string;
    diamonds: number;
    source: RechargeDoc['source'];
    agentId?: string | null;
    adminId?: string | null;
    note?: string | null;
    idempotencyKey: string;
  }): Promise<{ recharge: RechargeDoc; replayed: boolean }> {
    if (!Number.isSafeInteger(input.diamonds) || input.diamonds <= 0) throw badRequest('Diamonds must be a positive integer');
    if (input.agentId && input.agentId === input.uid) throw badRequest('Agents cannot recharge themselves');
    const existing = await this.ctx.col.recharges.findOne({ idempotencyKey: input.idempotencyKey });
    if (existing) return { recharge: existing, replayed: true };

    const reason: LedgerReason =
      input.source === 'agent' ? 'recharge_agent' : input.source === 'iap' ? 'recharge_iap' : 'recharge_admin';
    const doc: RechargeDoc = {
      userId: input.uid,
      diamonds: input.diamonds,
      source: input.source,
      agentId: input.agentId ?? null,
      adminId: input.adminId ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.ctx.clock.now(),
    };
    try {
      await this.ctx.db.withTransaction(async (session) => {
        const { insertedId } = await this.ctx.col.recharges.insertOne(doc, { session });
        doc._id = insertedId;
        const refId = String(insertedId);
        if (input.source === 'agent') {
          if (!input.agentId) throw badRequest('agentId required');
          const agent = await this.ctx.col.users.findOne({ _id: input.agentId }, { session, projection: { isAgent: 1 } });
          if (!agent?.isAgent) throw forbidden('Only agents can recharge users');
          await this.debit(session, { uid: input.agentId, currency: 'agent_stock', amount: input.diamonds, reason: 'agent_stock_transfer', refId, meta: { to: input.uid } });
        }
        await this.credit(session, {
          uid: input.uid,
          currency: 'diamonds',
          amount: input.diamonds,
          reason,
          refId,
          inc: { 'stats.totalRecharged': input.diamonds },
        });
        await this.ctx.services.levels.recalculate(input.uid, session);
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const raced = await this.ctx.col.recharges.findOne({ idempotencyKey: input.idempotencyKey });
        if (raced) return { recharge: raced, replayed: true };
      }
      throw err;
    }
    this.ctx.realtime.toUser(SOCKET.namespaces.app, input.uid, SOCKET.app.walletUpdated, { reason });
    return { recharge: doc, replayed: false };
  }

  /**
   * Admin balance correction. Moves a balance up or down without touching level counters —
   * corrections are not recharges. Never lets a balance go negative.
   */
  async adjust(input: { uid: string; currency: Currency; delta: number; adminId: string; note: string }): Promise<number> {
    if (!Number.isSafeInteger(input.delta) || input.delta === 0) throw badRequest('Delta must be a non-zero integer');
    return this.ctx.db.withTransaction(async (session) => {
      const m: Movement = {
        uid: input.uid,
        currency: input.currency,
        amount: Math.abs(input.delta),
        reason: input.currency === 'agent_stock' && input.delta > 0 ? 'agent_stock_topup' : 'admin_adjustment',
        refId: null,
        meta: { adminId: input.adminId, note: input.note },
      };
      return input.delta > 0 ? this.credit(session, m) : this.debit(session, m);
    });
  }

  async setAgent(uid: string, isAgent: boolean): Promise<void> {
    const res = await this.ctx.col.users.updateOne({ _id: uid, status: { $ne: 'deleted' } }, { $set: { isAgent } });
    if (!res.matchedCount) throw notFound('User');
  }

  async listRecharges(filter: { uid?: string; agentId?: string; source?: RechargeDoc['source']; from?: Date; to?: Date }, page: number, pageSize: number) {
    const q: Filter<RechargeDoc> = {};
    if (filter.uid) q.userId = filter.uid;
    if (filter.agentId) q.agentId = filter.agentId;
    if (filter.source) q.source = filter.source;
    if (filter.from || filter.to) q.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lt: filter.to } : {}) };
    const [items, total, sum] = await Promise.all([
      this.ctx.col.recharges.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      this.ctx.col.recharges.countDocuments(q),
      this.ctx.col.recharges.aggregate<{ total: number }>([{ $match: q }, { $group: { _id: null, total: { $sum: '$diamonds' } } }]).toArray(),
    ]);
    return { items, total, page, pageSize, totalDiamonds: sum[0]?.total ?? 0 };
  }
}
