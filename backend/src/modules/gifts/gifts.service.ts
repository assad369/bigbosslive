import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { ANIMATION_FORMATS, LIVEKIT_TOPICS, type Gift } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { GiftDoc, GiftTransactionDoc, LiveRoomDoc } from '../../db/schema.js';
import { badRequest, forbidden, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { activeVipTier } from '../users/users.presenter.js';

export const giftInput = z.object({
  name: z.string().trim().min(1).max(40),
  price: z.number().int().min(1).max(10_000_000),
  iconUrl: z.url(),
  animationUrl: z.url().nullable().default(null),
  animationFormat: z.enum(ANIMATION_FORMATS).default('none'),
  category: z.string().trim().min(1).max(30).default('popular'),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
  vipTierRequired: z.number().int().min(0).max(10).default(0),
});

export const sendGiftInput = z.object({
  giftId: z.string().regex(/^[a-f0-9]{24}$/i),
  quantity: z.number().int().min(1).max(9999),
  receiverIds: z.array(z.string().min(1).max(128)).min(1).max(10),
  roomId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().default(null),
});
export type SendGiftInput = z.infer<typeof sendGiftInput>;

export interface SendGiftResult {
  transactionId: string;
  totalCost: number;
  diamonds: number;
  replayed: boolean;
}

const CATALOG_TTL_MS = 60_000;

export function toGift(g: GiftDoc): Gift {
  return {
    id: String(g._id),
    name: g.name,
    price: g.price,
    iconUrl: g.iconUrl,
    animationUrl: g.animationUrl,
    animationFormat: g.animationFormat,
    category: g.category,
    sortOrder: g.sortOrder,
    active: g.active,
    vipTierRequired: g.vipTierRequired,
  };
}

export class GiftsService {
  private catalogCache: { gifts: Gift[]; at: number } | null = null;

  constructor(private readonly ctx: Ctx) {}

  async catalog(): Promise<Gift[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.gifts;
    const docs = await this.ctx.col.gifts.find({ active: true }).sort({ category: 1, sortOrder: 1, price: 1 }).toArray();
    const gifts = docs.map(toGift);
    this.catalogCache = { gifts, at: Date.now() };
    return gifts;
  }

  // ── Admin catalog management ───────────────────────────────────────────────

  async listAll() {
    return (await this.ctx.col.gifts.find().sort({ category: 1, sortOrder: 1 }).toArray()).map(toGift);
  }

  async create(input: z.infer<typeof giftInput>): Promise<Gift> {
    const now = this.ctx.clock.now();
    const doc: GiftDoc = { _id: new ObjectId(), ...input, createdAt: now, updatedAt: now };
    await this.ctx.col.gifts.insertOne(doc);
    this.catalogCache = null;
    return toGift(doc);
  }

  async update(id: ObjectId, input: Partial<z.infer<typeof giftInput>>): Promise<Gift> {
    const res = await this.ctx.col.gifts.findOneAndUpdate(
      { _id: id },
      { $set: { ...input, updatedAt: this.ctx.clock.now() } },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Gift');
    this.catalogCache = null;
    return toGift(res);
  }

  /** Gifts are deactivated, never deleted — transactions reference them forever. */
  async deactivate(id: ObjectId): Promise<void> {
    await this.update(id, { active: false });
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * Send a gift to one or more receivers, atomically and idempotently.
   *
   * One transaction: record the gift (unique idempotency key) → debit the sender → for each
   * receiver credit beans after platform + agency commission, bump `totalReceived`, recalc
   * level, and credit the agency owner's commission. A retry with the same key returns the
   * original result without charging again. Level moves for receivers only.
   */
  async send(senderId: string, rawKey: string, input: SendGiftInput): Promise<SendGiftResult> {
    const idempotencyKey = `${senderId}:${rawKey}`;
    const replay = await this.replay(senderId, idempotencyKey);
    if (replay) return replay;

    const receiverIds = [...new Set(input.receiverIds)];
    if (receiverIds.includes(senderId)) throw badRequest('You cannot send a gift to yourself');

    const economy = await this.ctx.services.config.get('economy');
    if (input.quantity > economy.maxGiftQuantity) throw badRequest(`Quantity cannot exceed ${economy.maxGiftQuantity}`);

    const gift = await this.ctx.col.gifts.findOne({ _id: new ObjectId(input.giftId) });
    if (!gift?.active) throw notFound('Gift');

    const sender = await this.ctx.services.users.get(senderId);
    if (gift.vipTierRequired > activeVipTier(sender.vip, this.ctx.clock.now())) {
      throw forbidden(`This gift requires VIP ${gift.vipTierRequired}`);
    }

    const receivers = await this.ctx.col.users
      .find({ _id: { $in: receiverIds }, status: 'active' }, { projection: { _id: 1, agencyId: 1 } })
      .toArray();
    if (receivers.length !== receiverIds.length) throw notFound('Receiver');

    let room: LiveRoomDoc | null = null;
    if (input.roomId) {
      room = await this.ctx.col.liveRooms.findOne({ _id: new ObjectId(input.roomId), status: 'live' });
      if (!room) throw notFound('Live room');
    }

    // Resolve agency commission rates up front (reads outside the transaction are fine:
    // rates are configuration, not balances).
    const agencyIds = receivers.map((r) => r.agencyId).filter((a): a is ObjectId => Boolean(a));
    const agencies = agencyIds.length
      ? await this.ctx.col.agencies.find({ _id: { $in: agencyIds }, status: 'active' }).toArray()
      : [];
    const agencyById = new Map(agencies.map((a) => [String(a._id), a]));

    const perReceiverCost = gift.price * input.quantity;
    const totalCost = perReceiverCost * receivers.length;
    if (!Number.isSafeInteger(totalCost)) throw badRequest('Gift total too large');

    const txId = new ObjectId();
    const now = this.ctx.clock.now();
    const doc: GiftTransactionDoc = {
      _id: txId,
      senderId,
      idempotencyKey,
      giftId: gift._id,
      giftName: gift.name,
      unitPrice: gift.price,
      quantity: input.quantity,
      receivers: receivers.map((r) => {
        const agency = r.agencyId ? agencyById.get(String(r.agencyId)) : undefined;
        const agencyRate = agency ? Math.min(agency.commissionRate, economy.maxAgencyRate) : 0;
        const platformFee = Math.floor(perReceiverCost * economy.platformFeeRate);
        const agencyFee = Math.floor(perReceiverCost * agencyRate);
        return {
          userId: r._id,
          cost: perReceiverCost,
          beans: perReceiverCost - platformFee - agencyFee,
          platformFee,
          agencyFee,
          agencyId: agency ? agency._id : null,
        };
      }),
      totalCost,
      roomId: room?._id ?? null,
      pkBattleId: room?.pkBattleId ?? null,
      createdAt: now,
    };

    let diamonds: number;
    try {
      diamonds = await this.ctx.db.withTransaction(async (session) => {
        await this.ctx.col.giftTransactions.insertOne(doc, { session });
        const refId = String(txId);
        const balance = await this.ctx.services.wallet.debit(session, {
          uid: senderId,
          currency: 'diamonds',
          amount: totalCost,
          reason: 'gift_sent',
          refId,
          inc: { 'stats.totalSent': totalCost },
        });
        const periodKey = this.ctx.services.agencies.currentPeriodKey();
        for (const r of doc.receivers) {
          await this.ctx.services.wallet.credit(session, {
            uid: r.userId,
            currency: 'beans',
            amount: r.beans,
            reason: 'gift_received',
            refId,
            meta: { from: senderId, gift: gift.name, quantity: input.quantity },
            inc: { 'stats.totalReceived': r.cost },
          });
          await this.ctx.services.levels.recalculate(r.userId, session);
          if (r.agencyId) {
            const agency = agencyById.get(String(r.agencyId))!;
            if (r.agencyFee > 0) {
              await this.ctx.services.wallet.credit(session, {
                uid: agency.ownerId,
                currency: 'beans',
                amount: r.agencyFee,
                reason: 'agency_commission',
                refId,
                meta: { host: r.userId, agencyId: String(agency._id) },
              });
            }
            await this.ctx.services.agencies.recordEarnings(session, r.agencyId, r.userId, r.beans, periodKey);
          }
          if (room && room.hostId === r.userId) {
            await this.ctx.col.liveRooms.updateOne(
              { _id: room._id },
              { $inc: { giftBeans: r.beans, giftCount: input.quantity } },
              { session },
            );
          }
        }
        return balance;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // A concurrent retry with the same key won the race.
        const raced = await this.replay(senderId, idempotencyKey);
        if (raced) return raced;
      }
      throw err;
    }

    await this.afterSend(doc, room, gift).catch((err: unknown) =>
      this.ctx.log.error({ err, txId: String(txId) }, 'post-gift side effects failed'),
    );
    return { transactionId: String(txId), totalCost, diamonds, replayed: false };
  }

  private async replay(senderId: string, idempotencyKey: string): Promise<SendGiftResult | null> {
    const existing = await this.ctx.col.giftTransactions.findOne({ idempotencyKey });
    if (!existing) return null;
    const { diamonds } = await this.ctx.services.wallet.balances(senderId);
    return { transactionId: String(existing._id), totalCost: existing.totalCost, diamonds, replayed: true };
  }

  /** Side effects that must not roll back a committed gift: PK scoring and the room broadcast. */
  private async afterSend(tx: GiftTransactionDoc, room: LiveRoomDoc | null, gift: GiftDoc): Promise<void> {
    if (tx.pkBattleId) {
      for (const r of tx.receivers) {
        await this.ctx.services.pk.addScore(tx.pkBattleId, r.userId, tx.senderId, r.cost);
      }
    }
    if (room) {
      const briefs = await this.ctx.services.users.briefs([tx.senderId, ...tx.receivers.map((r) => r.userId)]);
      await this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.gift, {
          transactionId: String(tx._id),
          sender: briefs.get(tx.senderId) ?? null,
          receivers: tx.receivers.map((r) => briefs.get(r.userId) ?? { id: r.userId }),
          gift: toGift(gift),
          quantity: tx.quantity,
          totalCost: tx.totalCost,
        })
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'gift broadcast failed'));
    }
  }

  async history(filter: { senderId?: string; receiverId?: string; roomId?: ObjectId; from?: Date; to?: Date }, page: number, pageSize: number) {
    const q: Filter<GiftTransactionDoc> = {};
    if (filter.senderId) q.senderId = filter.senderId;
    if (filter.receiverId) q['receivers.userId'] = filter.receiverId;
    if (filter.roomId) q.roomId = filter.roomId;
    if (filter.from || filter.to) q.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lt: filter.to } : {}) };
    const [items, total] = await Promise.all([
      this.ctx.col.giftTransactions.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      this.ctx.col.giftTransactions.countDocuments(q),
    ]);
    return { items, total, page, pageSize };
  }

  /** Top gifters to a user (profile "contributors" list), optionally since a date. */
  async topContributors(receiverId: string, since: Date | null, limit = 20) {
    const rows = await this.ctx.col.giftTransactions
      .aggregate<{ _id: string; total: number }>([
        { $match: { 'receivers.userId': receiverId, ...(since ? { createdAt: { $gte: since } } : {}) } },
        { $unwind: '$receivers' },
        { $match: { 'receivers.userId': receiverId } },
        { $group: { _id: '$senderId', total: { $sum: '$receivers.cost' } } },
        { $sort: { total: -1 } },
        { $limit: limit },
      ])
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r._id));
    return rows.map((r) => ({ user: briefs.get(r._id) ?? null, diamonds: r.total }));
  }

  /** Global rich (senders) / charm (receivers) leaderboards. */
  async leaderboard(kind: 'rich' | 'charm', since: Date, limit = 50) {
    const pipeline =
      kind === 'rich'
        ? [
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: '$senderId', total: { $sum: '$totalCost' } } },
          ]
        : [
            { $match: { createdAt: { $gte: since } } },
            { $unwind: '$receivers' },
            { $group: { _id: '$receivers.userId', total: { $sum: '$receivers.cost' } } },
          ];
    const rows = await this.ctx.col.giftTransactions
      .aggregate<{ _id: string; total: number }>([...pipeline, { $sort: { total: -1 } }, { $limit: limit }])
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r._id));
    return rows.map((r, i) => ({ rank: i + 1, user: briefs.get(r._id) ?? null, diamonds: r.total }));
  }
}
