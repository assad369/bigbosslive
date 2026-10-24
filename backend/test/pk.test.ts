import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
let giftId: string;
const rooms: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  for (const uid of ['a', 'b', 'c']) {
    await h.user(uid);
    const { room } = await h.ctx.services.live.start(uid, {
      type: 'video',
      title: `Live ${uid}`,
      coverUrl: null,
      tags: [],
    });
    rooms[uid] = room.id;
  }
  await h.user('fan', { wallet: { diamonds: 100_000 } });
  giftId = (
    await h.ctx.services.gifts.create({
      name: 'Rose',
      price: 10,
      iconUrl: 'https://cdn.test/rose.png',
      animationUrl: null,
      animationFormat: 'none',
      category: 'popular',
      sortOrder: 0,
      active: true,
      vipTierRequired: 0,
    })
  ).id;
});
afterAll(async () => h.close());

const gift = (to: string, qty: number) =>
  h.api
    .post('/v1/gifts/send')
    .set(h.as('fan'))
    .set('Idempotency-Key', key())
    .send({ giftId, quantity: qty, receiverIds: [to], roomId: rooms[to] });

describe('PK battles', () => {
  let battleId: string;

  it('invites a live host and notifies only them', async () => {
    const res = await h.api
      .post('/v1/pk/invite')
      .set(h.as('a'))
      .send({ opponentId: 'b', durationSec: 180 });
    expect(res.status).toBe(201);
    battleId = res.body.battle.id;
    const invite = h.livekit.topics('bb.pk.invitation').at(-1)!;
    expect(invite.identities).toEqual(['b']);
  });

  it('enforces one battle per host via the unique index', async () => {
    const busy = await h.api
      .post('/v1/pk/invite')
      .set(h.as('c'))
      .send({ opponentId: 'a', durationSec: 180 });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('pk_busy');
  });

  it('only the invitee can accept; accepting starts forwarding both ways', async () => {
    expect(
      (await h.api.post(`/v1/pk/${battleId}/respond`).set(h.as('a')).send({ accept: true })).status,
    ).toBe(403);
    const res = await h.api
      .post(`/v1/pk/${battleId}/respond`)
      .set(h.as('b'))
      .send({ accept: true });
    expect(res.status).toBe(200);
    expect(res.body.battle.status).toBe('active');
    expect(h.livekit.forwards.filter((f) => f.active)).toHaveLength(2);
    const roomA = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(rooms.a) });
    expect(String(roomA!.pkBattleId)).toBe(battleId);
  });

  it('scores gifts server-side from the debited amount', async () => {
    await gift('a', 5);
    await gift('b', 3);
    await gift('a', 1);
    const state = await h.api.get(`/v1/pk/${battleId}`).set(h.as('fan'));
    const scores = Object.fromEntries(
      state.body.battle.hosts.map((x: { uid: string; score: number }) => [x.uid, x.score]),
    );
    expect(scores).toEqual({ a: 60, b: 30 });
    expect(state.body.contributors.a[0]).toMatchObject({ score: 60 });
  });

  it('ignores gifts after the deadline and the sweeper ends the battle', async () => {
    h.clock.advance(181);
    await gift('b', 100);
    const result = await h.ctx.services.pk.sweep();
    expect(result.ended).toBe(1);
    const doc = await h.ctx.col.pkBattles.findOne({ _id: new ObjectId(battleId) });
    expect(doc).toMatchObject({
      status: 'ended',
      pkLive: false,
      winnerUid: 'a',
      isDraw: false,
      endReason: 'timeout',
    });
    expect(doc!.hosts[1].score).toBe(30);
    expect(h.livekit.forwards.filter((f) => !f.active)).toHaveLength(2);
    expect(
      (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(rooms.a) }))!.pkBattleId,
    ).toBeNull();
  });

  it('frees hosts for a new battle once ended', async () => {
    const res = await h.api
      .post('/v1/pk/invite')
      .set(h.as('c'))
      .send({ opponentId: 'a', durationSec: 300 });
    expect(res.status).toBe(201);
    battleId = res.body.battle.id;
  });

  it('expires unanswered invitations', async () => {
    h.clock.advance(31);
    expect((await h.ctx.services.pk.sweep()).expired).toBe(1);
    expect(await h.ctx.col.pkBattles.findOne({ _id: new ObjectId(battleId) })).toMatchObject({
      status: 'expired',
      pkLive: false,
    });
    const late = await h.api
      .post(`/v1/pk/${battleId}/respond`)
      .set(h.as('a'))
      .send({ accept: true });
    expect(late.status).toBe(404);
  });

  it('a host ending their live forfeits an active battle', async () => {
    const inv = await h.api
      .post('/v1/pk/invite')
      .set(h.as('b'))
      .send({ opponentId: 'c', durationSec: 180 });
    await h.api
      .post(`/v1/pk/${inv.body.battle.id}/respond`)
      .set(h.as('c'))
      .send({ accept: true })
      .expect(200);
    await h.api.post(`/v1/live/${rooms.c}/end`).set(h.as('c')).expect(200);
    const doc = await h.ctx.col.pkBattles.findOne({ _id: new ObjectId(inv.body.battle.id) });
    expect(doc).toMatchObject({
      status: 'ended',
      pkLive: false,
      winnerUid: 'b',
      endReason: 'host_left',
    });
  });

  it('respects the admin kill switch', async () => {
    await h.ctx.services.config.set('features', { pkEnabled: false }, 'admin');
    const res = await h.api
      .post('/v1/pk/invite')
      .set(h.as('a'))
      .send({ opponentId: 'b', durationSec: 180 });
    expect(res.status).toBe(403);
    await h.ctx.services.config.set('features', { pkEnabled: true }, 'admin');
  });
});
