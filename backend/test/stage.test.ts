import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { onCommit } from '../src/lib/after-commit.js';
import { migrateToSingleCurrency } from '../scripts/single-currency.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('host', { wallet: { diamonds: 500 } });
  await h.user('guest', { wallet: { diamonds: 40 }, level: { level: 2, points: 200 } });
  await h.user('fan', { wallet: { diamonds: 10_000 } });
});
afterAll(async () => h.close());

const webhook = (event: string, room: string, identity: string) =>
  h.api
    .post('/v1/webhooks/livekit')
    .set('Authorization', 'valid-signature')
    .set('Content-Type', 'application/webhook+json')
    .send(JSON.stringify({ event, room: { name: room }, participant: { identity } }));

interface Balances {
  kind: string;
  users: { uid: string; diamonds: number; level: number }[];
}
const balancePackets = () =>
  h.livekit
    .topics('bb.seats')
    .map((d) => d.payload as Balances)
    .filter((p) => p.kind === 'balances');

async function liveWithGuest() {
  const res = await h.api.post('/v1/live').set(h.as('host')).send({ type: 'video' });
  const roomId: string = res.body.room.id;
  const livekitRoom: string = res.body.room.livekitRoom;
  await h.api.post(`/v1/live/${roomId}/seats/request`).set(h.as('guest')).expect(202);
  await h.api
    .post(`/v1/live/${roomId}/seats/requests/guest`)
    .set(h.as('host'))
    .send({ accept: true })
    .expect(200);
  return { roomId, livekitRoom };
}

describe('stage tiles', () => {
  let roomId: string;
  let livekitRoom: string;

  it('room detail carries each seated person’s diamond balance', async () => {
    ({ roomId, livekitRoom } = await liveWithGuest());
    const detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('fan'));
    const seats = detail.body.room.seats as { userId: string | null; diamonds: number }[];
    expect(seats.find((s) => s.userId === 'host')?.diamonds).toBe(500);
    expect(seats.find((s) => s.userId === 'guest')?.diamonds).toBe(40);
    expect(seats.find((s) => !s.userId)?.diamonds).toBe(0);
  });

  it('a gift pushes the new balances and levels of everyone seated it touched', async () => {
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
    const before = balancePackets().length;
    await h.api
      .post('/v1/gifts/send')
      .set(h.as('fan'))
      .set('Idempotency-Key', 'stage-gift-1')
      .send({ giftId: gift.id, receiverIds: ['guest'], quantity: 1, roomId })
      .expect(200);
    const sent = balancePackets().slice(before);
    // The sender isn't seated, so only the guest's tile changes: 40 + 70 (30% platform fee).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.users).toEqual([{ uid: 'guest', diamonds: 110, level: expect.any(Number) }]);
    const giftPacket = h.livekit.topics('bb.gift').at(-1)!.payload as Record<string, unknown>;
    expect(giftPacket.roomGiftDiamonds).toBe(0); // the gift went to a guest, not the host
  });

  it('any wallet movement of a seated user is pushed (admin adjustment)', async () => {
    const before = balancePackets().length;
    await h.ctx.services.wallet.adjust({
      uid: 'host',
      currency: 'diamonds',
      delta: 25,
      adminId: 'staff',
      note: 'test',
    });
    const sent = balancePackets().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.users).toMatchObject([{ uid: 'host', diamonds: 525 }]);
  });

  it('a late participant_left does not unseat a guest who already rejoined', async () => {
    h.livekit.connected.set(livekitRoom, new Set(['host', 'guest']));
    await webhook('participant_left', livekitRoom, 'guest').expect(200);
    const room = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(room!.seats.find((s) => s.index === 1)?.userId).toBe('guest');
  });

  it('participant_left frees the seat once the guest is really gone', async () => {
    h.livekit.connected.set(livekitRoom, new Set(['host']));
    await webhook('participant_left', livekitRoom, 'guest').expect(200);
    const room = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(room!.seats.some((s) => s.userId === 'guest')).toBe(false);
    const seats = h.livekit.topics('bb.seats').at(-1)!.payload as { kind: string };
    expect(seats.kind).toBe('seats');
  });

  it('the sweep frees a vanished guest’s seat on the second strike, not the first', async () => {
    await h.api.post(`/v1/live/${roomId}/seats/request`).set(h.as('guest')).expect(202);
    await h.api
      .post(`/v1/live/${roomId}/seats/requests/guest`)
      .set(h.as('host'))
      .send({ accept: true })
      .expect(200);
    const seated = async () =>
      (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) }))!.seats.some(
        (s) => s.userId === 'guest',
      );

    // LiveKit can't answer: nothing is touched.
    h.livekit.connected.delete(livekitRoom);
    expect(await h.ctx.services.live.reconcileSeats()).toBe(0);
    expect(await seated()).toBe(true);

    // Missing: first strike only marks the seat.
    h.livekit.connected.set(livekitRoom, new Set(['host']));
    expect(await h.ctx.services.live.reconcileSeats()).toBe(0);
    expect(await seated()).toBe(true);

    // Seen again: the mark is cleared, so a later miss starts over.
    h.livekit.connected.set(livekitRoom, new Set(['host', 'guest']));
    await h.ctx.services.live.reconcileSeats();
    const cleared = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(cleared!.seats.find((s) => s.userId === 'guest')?.absentSince ?? null).toBeNull();

    h.livekit.connected.set(livekitRoom, new Set(['host']));
    await h.ctx.services.live.reconcileSeats();
    h.clock.advance(5);
    expect(await h.ctx.services.live.reconcileSeats()).toBe(0); // still inside the grace
    h.clock.advance(30);
    expect(await h.ctx.services.live.reconcileSeats()).toBe(1);
    expect(await seated()).toBe(false);
    expect(h.livekit.permissions.at(-1)).toMatchObject({ identity: 'guest', canPublish: false });
  });
});

describe('after-commit hook', () => {
  it('runs once after commit, and never for a rolled-back transaction', async () => {
    const ran: string[] = [];
    await h.ctx.db.withTransaction(async (session) => {
      onCommit(session, () => void ran.push('a'), 'k');
      onCommit(session, () => void ran.push('b'), 'k'); // same key: deduplicated
      expect(ran).toEqual([]);
    });
    expect(ran).toEqual(['b']);

    await expect(
      h.ctx.db.withTransaction(async (session) => {
        onCommit(session, () => void ran.push('rolled back'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ran).toEqual(['b']);
  });

  it('a failing callback does not fail the committed write', async () => {
    const result = await h.ctx.db.withTransaction(async (session) => {
      onCommit(session, () => {
        throw new Error('broadcast down');
      });
      return 'ok';
    });
    expect(result).toBe('ok');
  });
});

describe('single-currency migration', () => {
  it('folds beans into diamonds 1:1, renames stored fields and is safe to re-run', async () => {
    const raw = h.ctx.db.db;
    await h.user('legacy');
    await raw
      .collection('users')
      .updateOne(
        { _id: 'legacy' as never },
        { $set: { 'wallet.diamonds': 5, 'wallet.beans': 70 } },
      );
    await raw.collection('ledger').insertOne({
      userId: 'legacy',
      currency: 'beans',
      delta: 70,
      balanceAfter: 70,
      reason: 'gift_received',
      refId: null,
      createdAt: h.clock.now(),
    });
    const wd = await raw.collection('withdrawals').insertOne({ userId: 'legacy', beans: 50 });
    const tx = await raw.collection('gift_transactions').insertOne({
      receivers: [{ userId: 'legacy', cost: 100, beans: 70, platformFee: 30 }],
    });
    await raw
      .collection('app_config')
      .updateOne(
        { _id: 'economy' as never },
        { $set: { value: { beansPerUsd: 123, minWithdrawBeans: 9 } } },
        { upsert: true },
      );

    const report = await migrateToSingleCurrency(h.ctx.db, () => h.clock.now());
    expect(report).toMatchObject({ usersMerged: 1, diamondsMerged: 70 });

    const user = await raw.collection('users').findOne({ _id: 'legacy' as never });
    expect(user!.wallet).toMatchObject({ diamonds: 75 });
    expect(user!.wallet.beans).toBeUndefined();
    const rows = await raw.collection('ledger').find({ userId: 'legacy' }).toArray();
    expect(rows.map((r) => [r.currency, r.reason, r.balanceAfter])).toEqual([
      ['diamonds', 'gift_received', 70],
      ['diamonds', 'currency_merge', 75],
    ]);
    expect(rows[0]!.meta).toEqual({ legacyCurrency: 'beans' });
    expect(await raw.collection('withdrawals').findOne({ _id: wd.insertedId })).toMatchObject({
      diamonds: 50,
    });
    const gift = await raw.collection('gift_transactions').findOne({ _id: tx.insertedId });
    expect(gift!.receivers).toEqual([
      { userId: 'legacy', cost: 100, diamonds: 70, platformFee: 30 },
    ]);
    const economy = await raw.collection('app_config').findOne({ _id: 'economy' as never });
    expect(economy!.value).toEqual({ diamondsPerUsd: 123, minWithdrawDiamonds: 9 });

    const again = await migrateToSingleCurrency(h.ctx.db, () => h.clock.now());
    expect(again).toMatchObject({ usersMerged: 0, diamondsMerged: 0, ledgerRelabelled: 0 });
    expect(
      (await raw.collection('users').findOne({ _id: 'legacy' as never }))!.wallet.diamonds,
    ).toBe(75);
  });
});
