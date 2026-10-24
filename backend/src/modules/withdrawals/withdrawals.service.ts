import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import type { WithdrawalStatus } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { WithdrawalDoc } from '../../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';

export const withdrawalInput = z.object({
  beans: z.number().int().positive(),
  method: z.enum(['bank', 'mobile_wallet', 'paypal', 'other']),
  account: z
    .record(z.string().min(1).max(40), z.string().trim().min(1).max(200))
    .refine(
      (a) => Object.keys(a).length > 0 && Object.keys(a).length <= 10,
      'Account details required',
    ),
});

/**
 * Bean withdrawals. Requesting moves the beans out of the balance immediately (a "hold"), so
 * a user can never spend or double-withdraw beans under review. Rejection releases the hold;
 * approval and payout only change status. At most one pending request per user.
 */
export class WithdrawalsService {
  constructor(private readonly ctx: Ctx) {}

  async request(
    uid: string,
    rawKey: string,
    input: z.infer<typeof withdrawalInput>,
  ): Promise<WithdrawalDoc> {
    const [features, economy] = await Promise.all([
      this.ctx.services.config.get('features'),
      this.ctx.services.config.get('economy'),
    ]);
    if (!features.withdrawalsEnabled) throw forbidden('Withdrawals are temporarily disabled');
    if (input.beans < economy.minWithdrawBeans)
      throw badRequest(`Minimum withdrawal is ${economy.minWithdrawBeans} beans`);

    const idempotencyKey = `${uid}:${rawKey}`;
    const existing = await this.ctx.col.withdrawals.findOne({ idempotencyKey });
    if (existing) return existing;

    const doc: WithdrawalDoc = {
      _id: new ObjectId(),
      userId: uid,
      beans: input.beans,
      amountUsd: Math.floor((input.beans / economy.beansPerUsd) * 100) / 100,
      method: input.method,
      account: input.account,
      status: 'pending',
      idempotencyKey,
      note: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: this.ctx.clock.now(),
    };
    try {
      await this.ctx.db.withTransaction(async (session) => {
        await this.ctx.col.withdrawals.insertOne(doc, { session });
        await this.ctx.services.wallet.debit(session, {
          uid,
          currency: 'beans',
          amount: input.beans,
          reason: 'withdrawal_hold',
          refId: String(doc._id),
        });
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const raced = await this.ctx.col.withdrawals.findOne({ idempotencyKey });
        if (raced) return raced;
        throw conflict('You already have a pending withdrawal', 'withdrawal_pending');
      }
      throw err;
    }
    return doc;
  }

  async mine(uid: string, limit = 50) {
    return this.ctx.col.withdrawals
      .find({ userId: uid }, { projection: { account: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async list(filter: { status?: WithdrawalStatus; uid?: string }, page: number, pageSize: number) {
    const q: Filter<WithdrawalDoc> = {};
    if (filter.status) q.status = filter.status;
    if (filter.uid) q.userId = filter.uid;
    const [items, total, pendingSum] = await Promise.all([
      this.ctx.col.withdrawals
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.withdrawals.countDocuments(q),
      this.ctx.col.withdrawals
        .aggregate<{ beans: number; usd: number }>([
          { $match: { status: 'pending' } },
          { $group: { _id: null, beans: { $sum: '$beans' }, usd: { $sum: '$amountUsd' } } },
        ])
        .toArray(),
    ]);
    const briefs = await this.ctx.services.users.briefs(items.map((i) => i.userId));
    return {
      items: items.map((i) => ({ ...i, user: briefs.get(i.userId) ?? null })),
      total,
      page,
      pageSize,
      pending: { beans: pendingSum[0]?.beans ?? 0, usd: pendingSum[0]?.usd ?? 0 },
    };
  }

  async review(
    id: ObjectId,
    adminId: string,
    action: 'approve' | 'reject' | 'mark_paid',
    note: string | null,
  ): Promise<WithdrawalDoc> {
    const now = this.ctx.clock.now();
    if (action === 'reject') {
      const result = await this.ctx.db.withTransaction(async (session) => {
        const w = await this.ctx.col.withdrawals.findOneAndUpdate(
          { _id: id, status: { $in: ['pending', 'approved'] } },
          { $set: { status: 'rejected', note, reviewedBy: adminId, reviewedAt: now } },
          { session, returnDocument: 'after' },
        );
        if (!w) throw notFound('Reviewable withdrawal');
        await this.ctx.services.wallet.credit(session, {
          uid: w.userId,
          currency: 'beans',
          amount: w.beans,
          reason: 'withdrawal_release',
          refId: String(w._id),
        });
        return w;
      });
      await this.notify(result);
      return result;
    }
    const from: WithdrawalStatus = action === 'approve' ? 'pending' : 'approved';
    const to: WithdrawalStatus = action === 'approve' ? 'approved' : 'paid';
    const w = await this.ctx.col.withdrawals.findOneAndUpdate(
      { _id: id, status: from },
      { $set: { status: to, note, reviewedBy: adminId, reviewedAt: now } },
      { returnDocument: 'after' },
    );
    if (!w) throw notFound(`Withdrawal in status "${from}"`);
    await this.notify(w);
    return w;
  }

  private async notify(w: WithdrawalDoc): Promise<void> {
    const copy: Record<WithdrawalStatus, string> = {
      pending: 'Your withdrawal is under review',
      approved: 'Your withdrawal was approved and will be paid soon',
      paid: `Your withdrawal of $${w.amountUsd.toFixed(2)} has been paid`,
      rejected: `Your withdrawal was declined${w.note ? `: ${w.note}` : ''}. Beans were returned.`,
    };
    await this.ctx.services.notifications
      .notify(w.userId, {
        type: 'withdrawal',
        title: 'Withdrawal update',
        body: copy[w.status],
        data: { withdrawalId: String(w._id), status: w.status },
      })
      .catch(() => undefined);
  }
}
