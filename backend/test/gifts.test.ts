import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
let giftId: string;

beforeAll(async () => {
  h = await createHarness();
  await h.ctx.services.config.set(
    'economy',
    { platformFeeRate: 0.3, maxAgencyRate: 0.1, receivedLevelWeight: 1 },
    'test',
  );
  await h.ctx.services.levels.replaceAll([
    { level: 1, pointsRequired: 100, name: 'Bronze', color: '#8C6239', iconUrl: null },
    { level: 2, pointsRequired: 1000, name: 'Silver', color: '#C0C0C0', iconUrl: null },
    { level: 3, pointsRequired: 10000, name: 'Gold', color: '#C9A227', iconUrl: null },
  ]);
  const gift = await h.ctx.services.gifts.create({
    name: 'Crown',
    price: 500,
    iconUrl: 'https://cdn.test/crown.png',
    animationUrl: null,
    animationFormat: 'none',
    category: 'luxury',
    sortOrder: 0,
    active: true,
    vipTierRequired: 0,
  });
  giftId = gift.id;
});
afterAll(async () => h.close());

let n = 0;
async function pair(diamonds: number) {
  n++;
  const sender = await h.user(`s${n}`, { wallet: { diamonds } });
  const receiver = await h.user(`r${n}`);
  return { sender: sender._id, receiver: receiver._id };
}

const ledgerSum = async (uid: string, currency: string) => {
  const rows = await h.ctx.col.ledger
    .find({ userId: uid, currency: currency as 'diamonds' })
    .toArray();
  return rows.reduce((s, r) => s + r.delta, 0);
};

describe('gift transactions', () => {
  beforeEach(() => {
    h.livekit.data = [];
  });

  it('debits the sender, credits beans after commission, and writes the ledger', async () => {
    const { sender, receiver } = await pair(5000);
    const res = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 2, receiverIds: [receiver] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCost: 1000, diamonds: 4000, replayed: false });

    const s = await h.ctx.col.users.findOne({ _id: sender });
    const r = await h.ctx.col.users.findOne({ _id: receiver });
    expect(s!.wallet.diamonds).toBe(4000);
    expect(s!.stats.totalSent).toBe(1000);
    expect(r!.wallet.beans).toBe(700); // 30% platform fee
    expect(r!.stats.totalReceived).toBe(1000);
    expect(await ledgerSum(sender, 'diamonds')).toBe(-1000);
    expect(await ledgerSum(receiver, 'beans')).toBe(700);
  });

  it('moves level for the receiver only (level rule)', async () => {
    const { sender, receiver } = await pair(5000);
    await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 2, receiverIds: [receiver] });
    const s = await h.ctx.col.users.findOne({ _id: sender });
    const r = await h.ctx.col.users.findOne({ _id: receiver });
    expect(r!.level).toEqual({ level: 2, points: 1000 });
    expect(s!.level).toEqual({ level: 0, points: 0 });
  });

  it('is idempotent: a retry with the same key charges once', async () => {
    const { sender, receiver } = await pair(2000);
    const k = key();
    const send = () =>
      h.api
        .post('/v1/gifts/send')
        .set(h.as(sender))
        .set('Idempotency-Key', k)
        .send({ giftId, quantity: 1, receiverIds: [receiver] });
    const first = await send();
    const second = await send();
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.transactionId).toBe(first.body.transactionId);
    expect((await h.ctx.col.users.findOne({ _id: sender }))!.wallet.diamonds).toBe(1500);
  });

  it('charges once under concurrent retries', async () => {
    const { sender, receiver } = await pair(10_000);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.api
          .post('/v1/gifts/send')
          .set(h.as(sender))
          .set('Idempotency-Key', k)
          .send({ giftId, quantity: 1, receiverIds: [receiver] }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await h.ctx.col.users.findOne({ _id: sender }))!.wallet.diamonds).toBe(9500);
    expect(await h.ctx.col.giftTransactions.countDocuments({ senderId: sender })).toBe(1);
  });

  it('never overdraws under concurrent spends', async () => {
    const { sender, receiver } = await pair(1000); // enough for exactly two gifts
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.api
          .post('/v1/gifts/send')
          .set(h.as(sender))
          .set('Idempotency-Key', key())
          .send({ giftId, quantity: 1, receiverIds: [receiver] }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    const s = await h.ctx.col.users.findOne({ _id: sender });
    expect(s!.wallet.diamonds).toBe(0);
    expect(await ledgerSum(sender, 'diamonds')).toBe(-1000);
  });

  it('rolls back completely on insufficient balance', async () => {
    const { sender, receiver } = await pair(100);
    const res = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: [receiver] });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('insufficient_balance');
    expect(await h.ctx.col.giftTransactions.countDocuments({ senderId: sender })).toBe(0);
    expect((await h.ctx.col.users.findOne({ _id: receiver }))!.wallet.beans).toBe(0);
  });

  it('splits multi-receiver gifts and pays agency commission inside the transaction', async () => {
    const { sender, receiver } = await pair(10_000);
    const other = (await h.user('multi-other'))._id;
    const owner = (await h.user('agency-owner'))._id;
    const agency = await h.ctx.services.agencies.create({
      name: 'Gold Agency',
      ownerId: owner,
      logoUrl: null,
      commissionRate: 0.2,
    });
    await h.ctx.services.agencies.addMember(agency._id, receiver);

    const res = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: [receiver, other] });
    expect(res.body.totalCost).toBe(1000);
    // Agency rate is capped at maxAgencyRate (0.1): 500 − 150 platform − 50 agency = 300.
    expect((await h.ctx.col.users.findOne({ _id: receiver }))!.wallet.beans).toBe(300);
    expect((await h.ctx.col.users.findOne({ _id: other }))!.wallet.beans).toBe(350);
    expect((await h.ctx.col.users.findOne({ _id: owner }))!.wallet.beans).toBe(50);
    const member = await h.ctx.col.agencyMembers.findOne({ userId: receiver });
    expect(member!.periodBeans).toBe(300);
    // Agency commission never moves the owner's level.
    expect((await h.ctx.col.users.findOne({ _id: owner }))!.stats.totalReceived).toBe(0);
  });

  it('rejects self-gifting and unknown receivers', async () => {
    const { sender } = await pair(1000);
    const self = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: [sender] });
    expect(self.status).toBe(400);
    const ghost = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: ['ghost'] });
    expect(ghost.status).toBe(404);
  });

  it('requires an idempotency key', async () => {
    const { sender, receiver } = await pair(1000);
    const res = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .send({ giftId, quantity: 1, receiverIds: [receiver] });
    expect(res.status).toBe(400);
  });

  it('credits the room and broadcasts on the data channel', async () => {
    const { sender, receiver } = await pair(1000);
    const { room } = await h.ctx.services.live.start(receiver, {
      type: 'video',
      title: 'Hello',
      coverUrl: null,
      tags: [],
    });
    await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: [receiver], roomId: room.id });
    const doc = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(room.id) });
    expect(doc).toMatchObject({ giftBeans: 350, giftCount: 1 });
    expect(h.livekit.topics('bb.gift')).toHaveLength(1);
  });
});
