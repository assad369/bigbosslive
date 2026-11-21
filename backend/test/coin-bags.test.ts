import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { splitShares, feeSplit } from '../src/modules/coin-bags/split.js';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;

const RULES = {
  amountOptions: [1000, 10_000],
  shareOptions: [5, 10],
  feeRate: 0.1,
  minShare: 1,
  countdownSec: 30,
  grabWindowSec: 180,
  maxActiveGlobal: 20,
};

beforeAll(async () => {
  h = await createHarness();
  const features = await h.ctx.services.config.get('features');
  await h.ctx.services.config.set('features', { ...features, coinBagsEnabled: true }, 'test');
  await h.ctx.services.config.set('coinBags', RULES, 'test');
});
afterAll(async () => h.close());

let n = 0;
/** A live room with a host and `viewers` watching (presence rows), each with `diamonds`. */
async function room(viewers = 3, diamonds = 50_000) {
  n++;
  const host = `cb-host-${n}`;
  await h.user(host);
  const { room } = await h.ctx.services.live.start(host, {
    type: 'video',
    title: 'Bags',
    coverUrl: null,
    tags: [],
  });
  const oid = new ObjectId(room.id);
  const uids: string[] = [];
  for (let i = 0; i < viewers; i++) {
    const uid = `cb-v${n}-${i}`;
    await h.user(uid, { wallet: { diamonds } });
    await h.ctx.col.roomPresence.insertOne({
      roomId: oid,
      identity: uid,
      joinedAt: h.ctx.clock.now(),
    });
    uids.push(uid);
  }
  return { host, roomId: room.id, oid, viewers: uids };
}

const release = (uid: string, roomId: string, amount = 1000, shareCount = 5, k = key()) =>
  h.api
    .post('/v1/coin-bags')
    .set(h.as(uid))
    .set('Idempotency-Key', k)
    .send({ roomId, amount, shareCount });

const grab = (uid: string, bagId: string) =>
  h.api.post(`/v1/coin-bags/${bagId}/grab`).set(h.as(uid));

const wallet = async (uid: string) =>
  (await h.ctx.col.users.findOne({ _id: uid }))!.wallet.diamonds;
const ledger = async (uid: string, reason: string) =>
  (await h.ctx.col.ledger.find({ userId: uid, reason: reason as never }).toArray()).reduce(
    (s, r) => s + r.delta,
    0,
  );

describe('split', () => {
  it('always makes `count` integer shares ≥ minShare that sum to the pool', () => {
    for (let i = 0; i < 2000; i++) {
      const count = 1 + Math.floor(Math.random() * 60);
      const minShare = 1 + Math.floor(Math.random() * 5);
      const pool = count * minShare + Math.floor(Math.random() * 100_000);
      const shares = splitShares(pool, count, minShare);
      expect(shares).toHaveLength(count);
      expect(shares.every((s) => Number.isInteger(s) && s >= minShare)).toBe(true);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(pool);
    }
  });

  it('floors the fee', () => {
    expect(feeSplit(1001, 0.1)).toEqual({ fee: 100, pool: 901 });
  });
});

describe('coin bags', () => {
  it('releases: debits the amount, splits the pool, and a replay changes nothing', async () => {
    const r = await room();
    const [a] = r.viewers;
    const k = key();
    const res = await release(a!, r.roomId, 1000, 5, k);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: false,
      balance: 49_000,
      bag: { amount: 1000, pool: 900, shareCount: 5, grabbedCount: 0, status: 'active' },
    });
    expect(res.body.bag).not.toHaveProperty('shares');
    expect(await ledger(a!, 'coin_bag_release')).toBe(-1000);
    const shares = await h.ctx.col.coinBagShares
      .find({ bagId: new ObjectId(res.body.bag.id) })
      .toArray();
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBe(900);

    const again = await release(a!, r.roomId, 1000, 5, k);
    expect(again.body).toMatchObject({ replayed: true, bag: { id: res.body.bag.id } });
    expect(await wallet(a!)).toBe(49_000);

    // One running bag per releaser.
    const second = await release(a!, r.roomId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('coin_bag_active');

    // A chat line in that room.
    expect(
      h.livekit
        .topics('bb.system')
        .some((d) => (d.payload as { kind: string }).kind === 'coin_bag'),
    ).toBe(true);
    await h.ctx.services.live.end(r.oid, 'host', r.host);
  });

  it('refuses agency members, people outside the room, locked lives and bad options', async () => {
    const r = await room(2);
    const [member, outsider] = r.viewers;
    await h.ctx.col.users.updateOne({ _id: member }, { $set: { agencyId: new ObjectId() } });
    const blocked = await release(member!, r.roomId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('agency_member_coin_bag_blocked');
    expect(await wallet(member!)).toBe(50_000);

    await h.ctx.col.roomPresence.deleteMany({ roomId: r.oid, identity: outsider });
    const away = await release(outsider!, r.roomId);
    expect(away.body.error.code).toBe('not_in_room');

    await h.ctx.col.roomPresence.insertOne({
      roomId: r.oid,
      identity: outsider!,
      joinedAt: h.ctx.clock.now(),
    });
    expect((await release(outsider!, r.roomId, 777)).status).toBe(400);
    expect((await release(outsider!, r.roomId, 1000, 7)).status).toBe(400);

    await h.ctx.col.liveRooms.updateOne({ _id: r.oid }, { $set: { locked: true } });
    expect((await release(outsider!, r.roomId)).body.error.code).toBe('room_locked');

    const config = await h.api.get('/v1/coin-bags/config').set(h.as(member!));
    expect(config.body).toMatchObject({
      enabled: true,
      canRelease: false,
      refusal: { code: 'agency_member_coin_bag_blocked' },
    });
    await h.ctx.services.live.end(r.oid, 'host', r.host);
  });

  it('grabs once per person after the countdown; the last share finishes the bag', async () => {
    const r = await room(6);
    const [releaser, ...grabbers] = r.viewers;
    const { body } = await release(releaser!, r.roomId, 1000, 5);
    const id = body.bag.id as string;

    const early = await grab(grabbers[0]!, id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('coin_bag_not_open');

    h.clock.advance(31);
    expect((await grab(releaser!, id)).body.error.code).toBe('own_coin_bag');
    // The host is in the room too.
    const got: number[] = [];
    for (const uid of [...grabbers.slice(0, 4), r.host]) {
      const res = await grab(uid, id);
      expect(res.status).toBe(200);
      expect(res.body.duplicate).toBe(false);
      expect(res.body.remote).toBe(false);
      got.push(res.body.amount);
      expect(await ledger(uid, 'coin_bag_grab')).toBe(res.body.amount);
    }
    expect(got.reduce((a, b) => a + b, 0)).toBe(900);
    const replay = await grab(grabbers[0]!, id);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ duplicate: true, amount: got[0] });

    const bag = await h.ctx.col.coinBags.findOne({ _id: new ObjectId(id) });
    expect(bag).toMatchObject({ status: 'finished', grabbedCount: 5, refundedAmount: 0 });
    expect(bag!.activeSlot).toBeUndefined();
    const late = await grab(grabbers[4]!, id);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('coin_bag_empty');

    // Nobody's level moved: neither releasing nor grabbing is a recharge or a gift received.
    for (const uid of [releaser!, ...grabbers.slice(0, 4)]) {
      const u = await h.ctx.col.users.findOne({ _id: uid });
      expect(u!.stats.totalRecharged).toBe(0);
      expect(u!.stats.totalReceived).toBe(0);
    }
    // The releaser can release again.
    expect((await release(releaser!, r.roomId)).status).toBe(200);
    await h.ctx.services.live.end(r.oid, 'host', r.host);
  });

  it('lets the host of another live grab remotely, and nobody else from outside', async () => {
    const a = await room(1);
    const b = await room(1);
    const { body } = await release(a.viewers[0]!, a.roomId);
    h.clock.advance(31);
    const remote = await grab(b.host, body.bag.id);
    expect(remote.status).toBe(200);
    expect(remote.body.remote).toBe(true);
    const outsider = await grab(b.viewers[0]!, body.bag.id);
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe('not_in_room');
    await h.ctx.services.live.end(a.oid, 'host', a.host);
    await h.ctx.services.live.end(b.oid, 'host', b.host);
  });

  it('refunds unclaimed shares once when the window ends (never the fee)', async () => {
    const r = await room(2);
    const [releaser, grabber] = r.viewers;
    const { body } = await release(releaser!, r.roomId, 10_000, 10);
    h.clock.advance(31);
    const g = await grab(grabber!, body.bag.id);
    const taken = g.body.amount as number;

    h.clock.advance(180);
    expect(await h.ctx.services.coinBags.sweep()).toBe(0); // inside the grace
    h.clock.advance(5);
    expect(await h.ctx.services.coinBags.sweep()).toBe(1);
    expect(await h.ctx.services.coinBags.sweep()).toBe(0);
    const bag = await h.ctx.col.coinBags.findOne({ _id: new ObjectId(body.bag.id) });
    expect(bag).toMatchObject({ status: 'expired', refundedAmount: 9000 - taken });
    expect(await ledger(releaser!, 'coin_bag_refund')).toBe(9000 - taken);
    expect(await wallet(releaser!)).toBe(50_000 - 10_000 + 9000 - taken);
    expect((await grab(r.host, body.bag.id)).status).toBe(410);
    await h.ctx.services.live.end(r.oid, 'host', r.host);
  });

  it('refunds at once when the live ends, and staff can cancel', async () => {
    const r = await room(2);
    const [x, y] = r.viewers;
    await h.user('cb-admin', { adminRole: 'admin' });
    const first = await release(x!, r.roomId);
    const second = await release(y!, r.roomId);

    const cancel = await h.api
      .post(`/v1/admin/coin-bags/${second.body.bag.id}/cancel`)
      .set(h.as('cb-admin', 'admin'))
      .send({ reason: 'Released by mistake' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ status: 'cancelled', refunded: 900 });
    expect(await wallet(y!)).toBe(50_000 - 100);

    await h.ctx.services.live.end(r.oid, 'host', r.host);
    const bag = await h.ctx.col.coinBags.findOne({ _id: new ObjectId(first.body.bag.id) });
    expect(bag).toMatchObject({
      status: 'expired',
      closeReason: 'room_ended',
      refundedAmount: 900,
    });
    expect(await wallet(x!)).toBe(50_000 - 100);

    const list = await h.api.get('/v1/admin/coin-bags').set(h.as('cb-admin', 'admin'));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    const grabs = await h.api
      .get(`/v1/admin/coin-bags/${first.body.bag.id}/grabs`)
      .set(h.as('cb-admin', 'admin'));
    expect(grabs.body.items).toHaveLength(5);
    expect(grabs.body.items.every((s: { refundedAt: string | null }) => s.refundedAt)).toBe(true);
  });

  it('lists running bags with what I grabbed', async () => {
    const r = await room(2);
    const { body } = await release(r.viewers[0]!, r.roomId);
    h.clock.advance(31);
    const g = await grab(r.viewers[1]!, body.bag.id);
    const active = await h.api.get('/v1/coin-bags/active').set(h.as(r.viewers[1]!));
    expect(active.body.items.map((b: { id: string }) => b.id)).toContain(body.bag.id);
    expect(active.body.grabbed[body.bag.id]).toBe(g.body.amount);
    const detail = await h.api.get(`/v1/coin-bags/${body.bag.id}`).set(h.as(r.viewers[1]!));
    expect(detail.body).toMatchObject({ myAmount: g.body.amount });
    expect(detail.body.luckiest[0]).toMatchObject({ amount: g.body.amount });
    await h.ctx.services.live.end(r.oid, 'host', r.host);
  });
});
