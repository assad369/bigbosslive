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

const battle = (id: string) => h.ctx.col.pkBattles.findOne({ _id: new ObjectId(id) });

/** Invite + accept, then wait out the lead-in so gifts score. */
const startBattle = async (from: string, to: string, durationSec = 180) => {
  const inv = await h.api
    .post('/v1/pk/invite')
    .set(h.as(from))
    .send({ opponentId: to, durationSec });
  expect(inv.status).toBe(201);
  await h.api
    .post(`/v1/pk/${inv.body.battle.id}/respond`)
    .set(h.as(to))
    .send({ accept: true })
    .expect(200);
  h.clock.advance(3);
  return inv.body.battle.id as string;
};

/** Let the current round run out and sweep it. */
const finishRound = async (durationSec = 180) => {
  h.clock.advance(durationSec);
  return h.ctx.services.pk.sweep();
};

describe('PK battles', () => {
  let battleId: string;

  it('invites a live host and notifies only them', async () => {
    const res = await h.api
      .post('/v1/pk/invite')
      .set(h.as('a'))
      .send({ opponentId: 'b', durationSec: 180 });
    expect(res.status).toBe(201);
    battleId = res.body.battle.id;
    expect(res.body.battle).toMatchObject({ status: 'pending', invitedBy: 'a', maxRounds: 3 });
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

  it('lists opponents for the picker and flags busy hosts', async () => {
    const res = await h.api.get('/v1/pk/hosts').set(h.as('c'));
    expect(res.status).toBe(200);
    const rows = Object.fromEntries(
      res.body.items.map((x: { user: { id: string }; busy: boolean }) => [x.user.id, x.busy]),
    );
    expect(rows).toEqual({ a: true, b: true });
    // Friends = mutual follows only.
    await h.api.post('/v1/users/a/follow').set(h.as('c')).expect(200);
    expect((await h.api.get('/v1/pk/hosts?tab=friends').set(h.as('c'))).body.items).toEqual([]);
    await h.api.post('/v1/users/c/follow').set(h.as('a')).expect(200);
    const friends = await h.api.get('/v1/pk/hosts?tab=friends').set(h.as('c'));
    expect(friends.body.items.map((x: { user: { id: string } }) => x.user.id)).toEqual(['a']);
  });

  it('only the invitee can accept; accepting starts round 1 and forwards both ways', async () => {
    expect(
      (await h.api.post(`/v1/pk/${battleId}/respond`).set(h.as('a')).send({ accept: true })).status,
    ).toBe(403);
    const res = await h.api
      .post(`/v1/pk/${battleId}/respond`)
      .set(h.as('b'))
      .send({ accept: true });
    expect(res.status).toBe(200);
    expect(res.body.battle).toMatchObject({ status: 'active', round: 1, roundState: 'live' });
    expect(h.livekit.forwards.filter((f) => f.active)).toHaveLength(2);
    const roomA = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(rooms.a) });
    expect(String(roomA!.pkBattleId)).toBe(battleId);
  });

  it('ignores gifts during the lead-in, then scores them server-side', async () => {
    await gift('a', 50);
    h.clock.advance(3);
    await gift('a', 5);
    await gift('b', 3);
    await gift('a', 1);
    const state = await h.api.get(`/v1/pk/${battleId}`).set(h.as('fan'));
    const scores = Object.fromEntries(
      state.body.battle.hosts.map((x: { uid: string; score: number; roundScore: number }) => [
        x.uid,
        [x.score, x.roundScore],
      ]),
    );
    expect(scores).toEqual({ a: [60, 60], b: [30, 30] });
    expect(state.body.contributors.a[0]).toMatchObject({ score: 60 });
  });

  it('closes the round at its deadline and pauses for the next one', async () => {
    h.clock.advance(180);
    await gift('b', 100); // too late
    expect(await h.ctx.services.pk.sweep()).toMatchObject({ rounds: 1, ended: 0 });
    const doc = await battle(battleId);
    expect(doc).toMatchObject({
      status: 'active',
      roundState: 'paused',
      rounds: [{ round: 1, scores: [60, 30], winnerUid: 'a' }],
    });
    expect(doc!.hosts.map((x) => x.roundsWon)).toEqual([1, 0]);
    expect(h.livekit.topics('bb.pk.round_ended')).toHaveLength(2);
  });

  it('either host (only) starts the next round, which resets round scores', async () => {
    expect((await h.api.post(`/v1/pk/${battleId}/next-round`).set(h.as('fan'))).status).toBe(403);
    const res = await h.api.post(`/v1/pk/${battleId}/next-round`).set(h.as('b'));
    expect(res.status).toBe(200);
    expect(res.body.battle).toMatchObject({ round: 2, roundState: 'live' });
    expect(res.body.battle.hosts.map((x: { roundScore: number }) => x.roundScore)).toEqual([0, 0]);
    expect((await h.api.post(`/v1/pk/${battleId}/next-round`).set(h.as('a'))).status).toBe(409);
  });

  it('decides the battle on rounds won once every round is played', async () => {
    h.clock.advance(3);
    await gift('b', 10);
    expect(await finishRound()).toMatchObject({ rounds: 1, ended: 0 });
    await h.api.post(`/v1/pk/${battleId}/next-round`).set(h.as('a')).expect(200);
    h.clock.advance(3);
    await gift('a', 1);
    expect(await finishRound()).toMatchObject({ rounds: 1, ended: 1 });
    const doc = await battle(battleId);
    expect(doc).toMatchObject({
      status: 'ended',
      pkLive: false,
      winnerUid: 'a',
      isDraw: false,
      endReason: 'completed',
    });
    expect(doc!.hosts.map((x) => x.roundsWon)).toEqual([2, 1]);
    // b had more total diamonds, but rounds decide.
    expect(doc!.hosts.map((x) => x.score)).toEqual([70, 130]);
    expect(h.livekit.forwards.filter((f) => !f.active)).toHaveLength(2);
    expect(
      (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(rooms.a) }))!.pkBattleId,
    ).toBeNull();
  });

  it('ends early once a host has a majority of rounds', async () => {
    const id = await startBattle('b', 'c');
    await gift('b', 1);
    await finishRound();
    await h.api.post(`/v1/pk/${id}/next-round`).set(h.as('c')).expect(200);
    h.clock.advance(3);
    await gift('b', 1);
    expect(await finishRound()).toMatchObject({ ended: 1 });
    expect(await battle(id)).toMatchObject({
      status: 'ended',
      round: 2,
      winnerUid: 'b',
      endReason: 'completed',
    });
  });

  it('ends the battle when nobody starts the next round in time', async () => {
    const id = await startBattle('a', 'b');
    await finishRound();
    h.clock.advance(119);
    expect((await h.ctx.services.pk.sweep()).ended).toBe(0);
    h.clock.advance(2);
    expect((await h.ctx.services.pk.sweep()).ended).toBe(1);
    expect(await battle(id)).toMatchObject({ status: 'ended', isDraw: true, endReason: 'timeout' });
  });

  it('ending between rounds settles on rounds won; during a round it forfeits', async () => {
    const id = await startBattle('a', 'b');
    await gift('b', 1);
    await finishRound();
    await h.api.post(`/v1/pk/${id}/end`).set(h.as('b')).expect(204);
    expect(await battle(id)).toMatchObject({ winnerUid: 'b', endReason: 'host_ended' });

    const id2 = await startBattle('a', 'b');
    await gift('b', 5);
    await h.api.post(`/v1/pk/${id2}/end`).set(h.as('b')).expect(204);
    expect(await battle(id2)).toMatchObject({ winnerUid: 'a', endReason: 'forfeit' });
  });

  it('the invitee ending a pending invitation declines it', async () => {
    const inv = await h.api
      .post('/v1/pk/invite')
      .set(h.as('a'))
      .send({ opponentId: 'b', durationSec: 60 });
    await h.api.post(`/v1/pk/${inv.body.battle.id}/end`).set(h.as('b')).expect(204);
    expect(await battle(inv.body.battle.id)).toMatchObject({ status: 'rejected', pkLive: false });
  });

  it('expires unanswered invitations', async () => {
    const res = await h.api
      .post('/v1/pk/invite')
      .set(h.as('c'))
      .send({ opponentId: 'a', durationSec: 300 });
    expect(res.status).toBe(201);
    battleId = res.body.battle.id;
    h.clock.advance(31);
    expect((await h.ctx.services.pk.sweep()).expired).toBe(1);
    expect(await battle(battleId)).toMatchObject({ status: 'expired', pkLive: false });
    const late = await h.api
      .post(`/v1/pk/${battleId}/respond`)
      .set(h.as('a'))
      .send({ accept: true });
    expect(late.status).toBe(404);
  });

  it('a host ending their live forfeits an active battle', async () => {
    const id = await startBattle('b', 'c');
    await h.api.post(`/v1/live/${rooms.c}/end`).set(h.as('c')).expect(200);
    expect(await battle(id)).toMatchObject({
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
