import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let giftId: string;
beforeAll(async () => {
  h = await createHarness();
  const gift = await h.ctx.services.gifts.create({
    name: 'Rose',
    price: 100,
    iconUrl: 'https://cdn.test/rose.png',
    animationUrl: null,
    animationFormat: 'none',
    category: 'basic',
    sortOrder: 0,
    active: true,
    vipTierRequired: 0,
  });
  giftId = gift.id;
});
afterAll(async () => h.close());

const webhook = (event: string, room: string, identity: string) =>
  h.api
    .post('/v1/webhooks/livekit')
    .set('Authorization', 'valid-signature')
    .set('Content-Type', 'application/webhook+json')
    .send(JSON.stringify({ event, room: { name: room }, participant: { identity } }));

async function seat(roomId: string, host: string, uid: string) {
  await h.api.post(`/v1/live/${roomId}/seats/request`).set(h.as(uid)).expect(202);
  await h.api
    .post(`/v1/live/${roomId}/seats/requests/${uid}`)
    .set(h.as(host))
    .send({ accept: true })
    .expect(200);
}

type SeatView = { index: number; userId: string | null; seatedAt: string | null };
const seats = async (roomId: string) =>
  (await h.api.get(`/v1/live/${roomId}`).set(h.as('so-host'))).body.room.seats as SeatView[];

describe('seat join order', () => {
  let roomId: string;

  beforeAll(async () => {
    for (const uid of ['so-host', 'so-a', 'so-b', 'so-c']) await h.user(uid);
    await h.user('so-staff', { adminRole: 'moderator' });
    await h.user('so-support', { adminRole: 'support' });
    roomId = (await h.api.post('/v1/live').set(h.as('so-host')).send({ type: 'video' })).body.room
      .id;
  });

  it('stamps when each guest sat down, so a late joiner sorts after everyone on stage', async () => {
    await seat(roomId, 'so-host', 'so-a');
    h.clock.advance(5);
    await seat(roomId, 'so-host', 'so-b');
    h.clock.advance(5);
    await h.api.post(`/v1/live/${roomId}/seats/leave`).set(h.as('so-a')).expect(204);
    h.clock.advance(5);
    await seat(roomId, 'so-host', 'so-c');

    const all = await seats(roomId);
    const b = all.find((s) => s.userId === 'so-b')!;
    const c = all.find((s) => s.userId === 'so-c')!;
    // C reuses the lowest free seat, but its stamp still puts it after B.
    expect(c.index).toBeLessThan(b.index);
    expect(Date.parse(c.seatedAt!)).toBeGreaterThan(Date.parse(b.seatedAt!));
    // Empty seats carry no stamp.
    expect(all.filter((s) => !s.userId && s.index > 0).every((s) => s.seatedAt === null)).toBe(
      true,
    );
  });

  it('staff remove a guest from the stage only with live.moderate, and are audited', async () => {
    const indexOf = async (uid: string) =>
      (await seats(roomId)).find((s) => s.userId === uid)!.index;
    const remove = (as: Record<string, string>, index: number) =>
      h.api.post(`/v1/live/${roomId}/seats/${index}`).set(as).send({ action: 'remove' });

    const bIndex = await indexOf('so-b');
    expect((await remove(h.as('so-support', 'support'), bIndex)).status).toBe(403);
    await remove(h.as('so-staff', 'moderator'), bIndex).expect(204);
    expect((await seats(roomId)).some((s) => s.userId === 'so-b')).toBe(false);
    const audits = await h.ctx.col.auditLogs.find({ action: 'live.seat_manage' }).toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      adminId: 'so-staff',
      targetType: 'live_room',
      targetId: roomId,
      payload: { index: bIndex, action: 'remove' },
    });

    // The host's own removals are not staff actions.
    await remove(h.as('so-host'), await indexOf('so-c')).expect(204);
    expect(await h.ctx.col.auditLogs.countDocuments({ action: 'live.seat_manage' })).toBe(1);
  });
});

describe('wallet balances', () => {
  beforeAll(async () => {
    await h.user('wb-host', { wallet: { diamonds: 1_000 } });
    await h.user('wb-fan', { wallet: { diamonds: 10_000 } });
  });

  it('pushes wallet:updated with the new balance to everyone a gift touched', async () => {
    const sent: { uid: string; event: string; payload: unknown }[] = [];
    const original = h.ctx.realtime.toUser.bind(h.ctx.realtime);
    h.ctx.realtime.toUser = (ns, uid, event, payload) => {
      sent.push({ uid, event, payload });
      original(ns, uid, event, payload);
    };
    try {
      await h.api
        .post('/v1/gifts/send')
        .set(h.as('wb-fan'))
        .set('Idempotency-Key', 'wb-gift-1')
        .send({ giftId, receiverIds: ['wb-host'], quantity: 1 })
        .expect(200);
    } finally {
      h.ctx.realtime.toUser = original;
    }
    const updates = sent.filter((s) => s.event === 'wallet:updated');
    // 2% platform fee: the host gets 98.
    expect(updates.find((u) => u.uid === 'wb-host')?.payload).toMatchObject({ diamonds: 1_098 });
    expect(updates.find((u) => u.uid === 'wb-fan')?.payload).toMatchObject({ diamonds: 9_900 });
    expect(updates).toHaveLength(2);
  });

  it('shows the balance on public profiles', async () => {
    const res = await h.api.get('/v1/users/wb-host').set(h.as('wb-fan')).expect(200);
    expect(res.body.user.diamonds).toBe(1_098);
  });
});

describe('live history and summary', () => {
  let roomId: string;
  let livekitRoom: string;

  beforeAll(async () => {
    await h.user('lh-host');
    await h.user('lh-guest');
    await h.user('lh-fan', { wallet: { diamonds: 100_000 } });
    await h.user('lh-fan2', { wallet: { diamonds: 100_000 } });
    await h.user('lh-support', { adminRole: 'support' });
    h.clock.set(new Date('2026-03-15T12:00:00.000Z'));
    const res = await h.api.post('/v1/live').set(h.as('lh-host')).send({ type: 'video' });
    roomId = res.body.room.id;
    livekitRoom = res.body.room.livekitRoom;
  });

  it('counts joins, unique viewers, chat and reactions, idempotently under redelivery', async () => {
    await webhook('participant_joined', livekitRoom, 'lh-fan').expect(200);
    await webhook('participant_joined', livekitRoom, 'lh-fan').expect(200); // redelivered
    await webhook('participant_left', livekitRoom, 'lh-fan').expect(200);
    await webhook('participant_joined', livekitRoom, 'lh-fan').expect(200); // came back
    await webhook('participant_joined', livekitRoom, 'lh-fan2').expect(200);
    await webhook('participant_joined', livekitRoom, 'lh-host').expect(200); // never counted
    await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('lh-fan'))
      .send({ text: 'hi' })
      .expect(201);
    await h.api.post(`/v1/live/${roomId}/reactions`).set(h.as('lh-fan')).send({ count: 3 });
    const room = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(room).toMatchObject({ totalJoins: 3, uniqueViewers: 2, chatMessages: 1, reactions: 3 });
  });

  it('refuses a summary while the live is running', async () => {
    const res = await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-host'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('live_running');
  });

  it('summarises gifts, gifters and new followers; freezes after the settle window', async () => {
    await seat(roomId, 'lh-host', 'lh-guest');
    const send = (from: string, to: string[], quantity: number, key: string) =>
      h.api
        .post('/v1/gifts/send')
        .set(h.as(from))
        .set('Idempotency-Key', key)
        .send({ giftId, receiverIds: to, quantity, roomId })
        .expect(200);
    await send('lh-fan', ['lh-host'], 3, 'lh-gift-1'); // 300 to the host
    await send('lh-fan2', ['lh-host', 'lh-guest'], 1, 'lh-gift-2'); // 100 each
    await h.api.post('/v1/users/lh-host/follow').set(h.as('lh-fan2')).expect(200);

    h.clock.advance(600);
    await h.api.post(`/v1/live/${roomId}/end`).set(h.as('lh-host')).expect(200);

    const early = await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-host')).expect(200);
    expect(early.body.summary).toMatchObject({
      final: false,
      durationSec: 600,
      audience: {
        peakViewers: expect.any(Number),
        totalJoins: 3,
        uniqueViewers: 2,
        newFollowers: 1,
      },
      engagement: { chatMessages: 1, reactions: 3 },
      gifts: {
        hostDiamonds: 400,
        hostEarnings: 392,
        roomDiamonds: 500,
        giftCount: 5,
        gifters: 2,
      },
    });
    const { topGifters, topGifts } = early.body.summary.gifts;
    expect(topGifters.map((g: { user: { id: string } }) => g.user.id)).toEqual([
      'lh-fan',
      'lh-fan2',
    ]);
    expect(topGifters[0]).toMatchObject({ rank: 1, diamonds: 300, gifts: 3 });
    expect(topGifts[0]).toMatchObject({
      gift: { id: giftId, name: 'Rose', iconUrl: 'https://cdn.test/rose.png' },
      count: 5,
      diamonds: 500,
    });
    // Not frozen inside the window.
    expect((await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) }))!.summary).toBeNull();

    h.clock.advance(61);
    const done = await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-host')).expect(200);
    expect(done.body.summary.final).toBe(true);
    expect(done.body.summary.gifts.roomDiamonds).toBe(500);
    // Frozen: a gift row appearing later no longer changes it.
    await h.ctx.col.giftTransactions.insertOne({
      _id: new ObjectId(),
      senderId: 'lh-fan',
      idempotencyKey: 'late',
      giftId: new ObjectId(giftId),
      giftName: 'Rose',
      unitPrice: 100,
      quantity: 1,
      receivers: [
        {
          userId: 'lh-host',
          cost: 100,
          diamonds: 98,
          platformFee: 2,
          agencyFee: 0,
          agencyId: null,
        },
      ],
      totalCost: 100,
      roomId: new ObjectId(roomId),
      pkBattleId: null,
      createdAt: h.clock.now(),
    });
    const again = await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-host')).expect(200);
    expect(again.body.summary.gifts.roomDiamonds).toBe(500);
  });

  it('shows a summary only to its host and staff who read lives', async () => {
    expect((await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-fan'))).status).toBe(403);
    await h.api.get(`/v1/live/${roomId}/summary`).set(h.as('lh-support', 'support')).expect(200);
  });

  it('groups a month by the local day each live started', async () => {
    // 19:00 UTC on the 15th is 01:00 on the 16th at +06:00.
    h.clock.set(new Date('2026-03-15T19:00:00.000Z'));
    const second = (await h.api.post('/v1/live').set(h.as('lh-host')).send({ type: 'audio' })).body
      .room.id as string;
    h.clock.advance(1800);
    await h.api.post(`/v1/live/${second}/end`).set(h.as('lh-host')).expect(200);

    const utc = await h.api
      .get('/v1/users/lh-host/live-history/monthly')
      .query({ month: '2026-03', tz: '+00:00' })
      .set(h.as('lh-host'))
      .expect(200);
    expect(utc.body).toMatchObject({
      month: '2026-03',
      sessionCount: 2,
      liveDays: 1,
      totalSeconds: 2400,
      diamonds: 392,
      earliestMonth: '2026-03',
    });
    expect(utc.body.days[0].sessions.map((s: { id: string }) => s.id)).toEqual([second, roomId]);

    const dhaka = await h.api
      .get('/v1/users/lh-host/live-history/monthly')
      .query({ month: '2026-03', tz: '+06:00' })
      .set(h.as('lh-host'))
      .expect(200);
    expect(dhaka.body.liveDays).toBe(2);
    expect(dhaka.body.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-03-16',
      '2026-03-15',
    ]);
    expect(dhaka.body.days[1]).toMatchObject({ sessionCount: 1, totalSeconds: 600, diamonds: 392 });

    const empty = await h.api
      .get('/v1/users/lh-host/live-history/monthly')
      .query({ month: '2026-02', tz: '+06:00' })
      .set(h.as('lh-host'))
      .expect(200);
    expect(empty.body).toMatchObject({ sessionCount: 0, days: [], earliestMonth: '2026-03' });
  });

  it('validates the query and keeps history private', async () => {
    const bad = (query: Record<string, string>) =>
      h.api.get('/v1/users/lh-host/live-history/monthly').query(query).set(h.as('lh-host'));
    expect((await bad({ month: '2026-13' })).status).toBe(422);
    expect((await bad({ tz: '6' })).status).toBe(422);
    expect(
      (await h.api.get('/v1/users/lh-host/live-history/monthly').set(h.as('lh-fan'))).status,
    ).toBe(401);
  });
});
