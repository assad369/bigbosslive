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

  it('debits the sender, credits diamonds after commission, and writes the ledger', async () => {
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
    expect(r!.wallet.diamonds).toBe(700); // 30% platform fee
    expect(r!.stats.totalReceived).toBe(1000);
    expect(await ledgerSum(sender, 'diamonds')).toBe(-1000);
    expect(await ledgerSum(receiver, 'diamonds')).toBe(700);
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
    expect((await h.ctx.col.users.findOne({ _id: receiver }))!.wallet.diamonds).toBe(0);
  });

  it('splits multi-receiver gifts and pays agency commission inside the transaction', async () => {
    const { sender, receiver } = await pair(10_000);
    const other = (await h.user('multi-other'))._id;
    const owner = (await h.user('agency-owner'))._id;
    const agency = await h.ctx.services.agencies.create(
      { name: 'Gold Agency', owner, logoUrl: null, commissionRate: 0.2 },
      owner,
    );
    await h.ctx.services.agencies.addMember(agency._id, receiver, owner);

    const res = await h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity: 1, receiverIds: [receiver, other] });
    expect(res.body.totalCost).toBe(1000);
    // Agency rate is capped at maxAgencyRate (0.1): 500 − 150 platform − 50 agency = 300.
    expect((await h.ctx.col.users.findOne({ _id: receiver }))!.wallet.diamonds).toBe(300);
    expect((await h.ctx.col.users.findOne({ _id: other }))!.wallet.diamonds).toBe(350);
    expect((await h.ctx.col.users.findOne({ _id: owner }))!.wallet.diamonds).toBe(50);
    const member = await h.ctx.col.agencyMembers.findOne({ userId: receiver });
    expect(member!.periodDiamonds).toBe(300);
    const counters = await h.ctx.col.agencies.findOne({ _id: agency._id });
    expect(counters!.period).toMatchObject({ diamonds: 300, commission: 50, gifts: 1 });
    expect(counters!.lifetime).toMatchObject({ diamonds: 300, commission: 50, gifts: 1 });
    const day = await h.ctx.col.agencyDailyStats.findOne({ agencyId: agency._id });
    expect(day).toMatchObject({ userId: receiver, diamonds: 300, commission: 50, gifts: 1 });
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
    expect(doc).toMatchObject({ giftDiamonds: 350, giftCount: 1 });
    expect(h.livekit.topics('bb.gift')).toHaveLength(1);
  });
});

describe('room gifts', () => {
  beforeEach(() => {
    h.livekit.data = [];
  });

  async function liveRoom(diamonds: number) {
    const { sender, receiver: host } = await pair(diamonds);
    const { room } = await h.ctx.services.live.start(host, {
      type: 'video',
      title: 'Room gifts',
      coverUrl: null,
      tags: [],
    });
    return { sender, host, roomId: room.id, oid: new ObjectId(room.id) };
  }

  const send = (sender: string, receiver: string, roomId: string, k = key()) =>
    h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', k)
      .send({ giftId, quantity: 2, receiverIds: [receiver], roomId });

  it('saves one chat message per gift and sends it inside bb.gift', async () => {
    const { sender, host, roomId, oid } = await liveRoom(5000);
    const k = key();
    const res = await send(sender, host, roomId, k);
    expect(res.status).toBe(200);

    const rows = await h.ctx.col.liveMessages.find({ roomId: oid }).toArray();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!._id)).toBe(res.body.transactionId);
    expect(rows[0]).toMatchObject({
      userId: sender,
      type: 'gift',
      gift: {
        transactionId: res.body.transactionId,
        giftId,
        name: 'Crown',
        iconUrl: 'https://cdn.test/crown.png',
        quantity: 2,
        totalCost: 1000,
        receivers: [{ id: host, displayName: expect.any(String) }],
      },
    });

    const packet = h.livekit.topics('bb.gift')[0]!.payload as {
      message: Record<string, unknown> & { user: Record<string, unknown> };
    };
    expect(packet.message).toMatchObject({
      id: res.body.transactionId,
      type: 'gift',
      text: expect.stringContaining('sent Crown ×2 to'),
      gift: { name: 'Crown', quantity: 2 },
    });
    expect(packet.message.user).toMatchObject({
      uid: sender,
      role: 'audience',
      level: expect.any(Number),
    });

    // A retry with the same key replays: no second charge, row or broadcast.
    const again = await send(sender, host, roomId, k);
    expect(again.body.replayed).toBe(true);
    expect(await h.ctx.col.liveMessages.countDocuments({ roomId: oid })).toBe(1);
    expect(h.livekit.topics('bb.gift')).toHaveLength(1);
  });

  it('a reply to a gift message quotes the gift', async () => {
    const { sender, host, roomId } = await liveRoom(5000);
    const sent = await send(sender, host, roomId);
    const reply = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as(host))
      .send({ type: 'text', text: 'Thank you!', replyToId: sent.body.transactionId });
    expect(reply.status).toBe(201);
    expect(reply.body.message.replyTo).toMatchObject({
      id: sent.body.transactionId,
      userId: sender,
      text: '🎁 Crown ×2',
    });
  });

  it('gifts a guest on stage and a viewer who is watching', async () => {
    const { sender, roomId, oid } = await liveRoom(5000);
    const guest = (await h.user(`guest${n}`))._id;
    const viewer = (await h.user(`viewer${n}`))._id;
    await h.ctx.col.liveRooms.updateOne(
      { _id: oid, 'seats.index': 1 },
      { $set: { 'seats.$.userId': guest } },
    );
    await h.ctx.col.roomPresence.insertOne({
      roomId: oid,
      identity: viewer,
      joinedAt: h.ctx.clock.now(),
    });
    expect((await send(sender, guest, roomId)).status).toBe(200);
    expect((await send(sender, viewer, roomId)).status).toBe(200);
    const v = await h.ctx.col.users.findOne({ _id: viewer });
    expect(v!.wallet.diamonds).toBe(700);
    // Only the host's gifts count towards the room total.
    const room = await h.ctx.col.liveRooms.findOne({ _id: oid });
    expect(room!.giftDiamonds).toBe(0);
  });

  it('refuses a receiver who is not in the room, without charging', async () => {
    const { sender, roomId, oid } = await liveRoom(5000);
    const outsider = (await h.user(`out${n}`, { displayName: 'Outsider' }))._id;
    const res = await send(sender, outsider, roomId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'receiver_not_in_room',
      message: 'Outsider is no longer in this live',
    });
    const s = await h.ctx.col.users.findOne({ _id: sender });
    expect(s!.wallet.diamonds).toBe(5000);
    expect(await ledgerSum(sender, 'diamonds')).toBe(0);
    expect(await h.ctx.col.liveMessages.countDocuments({ roomId: oid })).toBe(0);
    expect(h.livekit.topics('bb.gift')).toHaveLength(0);
  });
});

describe('platform-wide gift announcement', () => {
  type Emit = [namespace: string, event: string, payload: Record<string, unknown>];
  let emits: Emit[] = [];
  let restore: () => void;

  beforeAll(() => {
    const original = h.ctx.realtime.broadcast.bind(h.ctx.realtime);
    h.ctx.realtime.broadcast = (ns, event, payload) => {
      emits.push([ns, event, payload as Record<string, unknown>]);
      original(ns, event, payload);
    };
    restore = () => {
      h.ctx.realtime.broadcast = original;
    };
  });
  afterAll(async () => {
    restore();
    await h.ctx.services.config.set('live', { giftBannerMinDiamonds: 0 }, 'test');
  });
  beforeEach(() => {
    emits = [];
  });
  const announcements = () => emits.filter(([, event]) => event === 'gift:announcement');

  const send = (sender: string, receiver: string, quantity: number, roomId: string | null) =>
    h.api
      .post('/v1/gifts/send')
      .set(h.as(sender))
      .set('Idempotency-Key', key())
      .send({ giftId, quantity, receiverIds: [receiver], roomId });

  it('announces a committed room gift to every app socket, once', async () => {
    const { sender, receiver: host } = await pair(5000);
    const { room } = await h.ctx.services.live.start(host, {
      type: 'video',
      title: 'Banner',
      coverUrl: null,
      tags: [],
    });
    const res = await send(sender, host, 3, room.id).expect(200);
    expect(announcements()).toHaveLength(1);
    const [ns, , payload] = announcements()[0]!;
    expect(ns).toBe('/');
    expect(payload).toEqual({
      id: res.body.transactionId,
      roomId: room.id,
      sender: expect.objectContaining({ id: sender }),
      receivers: [{ id: host, displayName: expect.any(String) }],
      gift: { id: giftId, name: 'Crown', iconUrl: 'https://cdn.test/crown.png' },
      quantity: 3,
      totalCost: 1500,
      at: expect.any(String),
    });
  });

  it('announces profile gifts too, with no room', async () => {
    const { sender, receiver } = await pair(5000);
    await send(sender, receiver, 1, null).expect(200);
    expect(announcements()[0]![2]).toMatchObject({ roomId: null, totalCost: 500 });
  });

  it('skips gifts below live.giftBannerMinDiamonds', async () => {
    await h.ctx.services.config.set('live', { giftBannerMinDiamonds: 1000 }, 'test');
    const { sender, receiver } = await pair(5000);
    await send(sender, receiver, 1, null).expect(200);
    expect(announcements()).toHaveLength(0);
    await send(sender, receiver, 2, null).expect(200);
    expect(announcements()).toHaveLength(1);
    await h.ctx.services.config.set('live', { giftBannerMinDiamonds: 0 }, 'test');
  });

  it('a failing broadcast never fails the gift', async () => {
    const working = h.ctx.realtime.broadcast;
    h.ctx.realtime.broadcast = () => {
      throw new Error('socket down');
    };
    try {
      const { sender, receiver } = await pair(5000);
      const res = await send(sender, receiver, 1, null);
      expect(res.status).toBe(200);
      expect((await h.ctx.col.users.findOne({ _id: sender }))!.wallet.diamonds).toBe(4500);
    } finally {
      h.ctx.realtime.broadcast = working;
    }
  });
});
