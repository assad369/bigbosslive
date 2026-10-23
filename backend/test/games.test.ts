import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, key, type Harness } from './helpers/harness.js';
import { GAME_DEFINITIONS, theoreticalRtp } from '../src/modules/games/definitions.js';
import { floats, hashSeed, weightedPick } from '../src/modules/games/rng.js';
import { compare, evaluate, type Card } from '../src/modules/games/teenPatti.js';

describe('provably-fair RNG', () => {
  it('is deterministic per seed and message', () => {
    expect(floats('seed', 'g:1', 7)).toEqual(floats('seed', 'g:1', 7));
    expect(floats('seed', 'g:1', 3)).not.toEqual(floats('seed', 'g:2', 3));
    for (const f of floats('x', 'y', 50)) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('picks by weight', () => {
    expect(weightedPick({ a: 1, b: 0, c: 3 }, 0)).toBe('a');
    expect(weightedPick({ a: 1, b: 0, c: 3 }, 0.3)).toBe('c');
    expect(weightedPick({ a: 1, b: 0, c: 3 }, 0.999)).toBe('c');
  });

  it('default weighted configs keep RTP below 100%', () => {
    for (const key of ['golden_wheel', 'fortune_ferris'] as const) {
      const rtp = Object.values(theoreticalRtp(GAME_DEFINITIONS[key].defaultConfig));
      for (const r of rtp) {
        expect(r).toBeLessThan(1);
        expect(r).toBeGreaterThan(0.85);
      }
    }
  });
});

describe('teen patti hand ranking', () => {
  const ev = (...c: Card[]) => evaluate(c as [Card, Card, Card]);
  it('orders categories', () => {
    const trail = ev('As', 'Ah', 'Ad');
    const pure = ev('Qs', 'Ks', 'As');
    const seq = ev('Qs', 'Kh', 'Ad');
    const color = ev('2s', '7s', 'Ks');
    const pair = ev('Ks', 'Kh', '2d');
    const high = ev('As', '7h', '2d');
    const ordered = [trail, pure, seq, color, pair, high];
    for (let i = 0; i < ordered.length - 1; i++)
      expect(compare(ordered[i]!, ordered[i + 1]!)).toBeGreaterThan(0);
  });
  it('ranks A-2-3 just below A-K-Q', () => {
    expect(compare(ev('Ah', 'Kd', 'Qs'), ev('Ah', '2d', '3s'))).toBeGreaterThan(0);
    expect(compare(ev('Ah', '2d', '3s'), ev('Kh', 'Qd', 'Js'))).toBeGreaterThan(0);
  });
  it('resolves rounds deterministically with a full reveal', () => {
    const r1 = GAME_DEFINITIONS.teen_patti.resolve(
      'abc',
      9,
      GAME_DEFINITIONS.teen_patti.defaultConfig,
    );
    const r2 = GAME_DEFINITIONS.teen_patti.resolve(
      'abc',
      9,
      GAME_DEFINITIONS.teen_patti.defaultConfig,
    );
    expect(r1).toEqual(r2);
    expect(['A', 'B', 'C']).toContain(r1.outcome);
    const cards = Object.values(r1.reveal).flatMap((s) => (s as { cards: string[] }).cards);
    expect(new Set(cards).size).toBe(9);
  });
});

describe('round engine and settlement', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.ctx.services.games.ensureRegistry();
    await h.ctx.services.games.updateMeta('golden_wheel', { enabled: true });
    for (const uid of ['p1', 'p2', 'p3']) await h.user(uid, { wallet: { diamonds: 50_000 } });
  });
  afterAll(async () => h.close());

  it('runs betting → locked → settled with exact accounting', async () => {
    await h.ctx.services.games.tick();
    const state = await h.api.get('/v1/games/golden_wheel/state').set(h.as('p1'));
    const round = state.body.round;
    expect(round.status).toBe('betting');
    expect(round.serverSeed).toBeNull();
    expect(round.serverSeedHash).toMatch(/^[a-f0-9]{64}$/);

    const bets: [string, string, number][] = [
      ['p1', 'cherry', 1000],
      ['p1', 'crown', 100],
      ['p2', 'lemon', 10_000],
      ['p3', 'coin', 1000],
    ];
    for (const [uid, option, amount] of bets) {
      const r = await h.api
        .post('/v1/games/golden_wheel/bets')
        .set(h.as(uid))
        .set('Idempotency-Key', key())
        .send({ roundId: round.id, option, amount });
      expect(r.status).toBe(200);
    }
    // Replay with the same key does not double-stake.
    const k = key();
    await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p3'))
      .set('Idempotency-Key', k)
      .send({ roundId: round.id, option: 'coin', amount: 1000 });
    const replay = await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p3'))
      .set('Idempotency-Key', k)
      .send({ roundId: round.id, option: 'coin', amount: 1000 });
    expect(replay.body.replayed).toBe(true);

    h.clock.advance(26);
    await h.ctx.services.games.tick();
    const late = await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p1'))
      .set('Idempotency-Key', key())
      .send({ roundId: round.id, option: 'cherry', amount: 100 });
    expect(late.status).toBe(409);

    h.clock.advance(9);
    await h.ctx.services.games.tick();
    const settled = await h.ctx.col.gameRounds.findOne({ status: 'settled' });
    expect(settled).not.toBeNull();

    // Every user's ledger reconciles to their balance, and house P&L = stakes − payouts.
    let staked = 0;
    let paid = 0;
    for (const uid of ['p1', 'p2', 'p3']) {
      const user = await h.ctx.col.users.findOne({ _id: uid });
      const rows = await h.ctx.col.ledger.find({ userId: uid, currency: 'diamonds' }).toArray();
      expect(50_000 + rows.reduce((s, r) => s + r.delta, 0)).toBe(user!.wallet.diamonds);
      staked += -rows.filter((r) => r.reason === 'game_bet').reduce((s, r) => s + r.delta, 0);
      paid += rows.filter((r) => r.reason === 'game_payout').reduce((s, r) => s + r.delta, 0);
    }
    expect(staked).toBe(13_100);
    expect(settled!.payoutTotal).toBe(paid);
    expect(await h.ctx.col.gameBets.countDocuments({ status: 'placed' })).toBe(0);

    const verify = await h.api.get(`/v1/games/rounds/${round.id}/verify`).set(h.as('p1'));
    expect(verify.body.hashMatches).toBe(true);
    expect(hashSeed(verify.body.serverSeed)).toBe(round.serverSeedHash);
    expect(
      GAME_DEFINITIONS.golden_wheel.resolve(
        verify.body.serverSeed,
        verify.body.roundNo,
        GAME_DEFINITIONS.golden_wheel.defaultConfig,
      ).outcome,
    ).toBe(verify.body.outcome);

    // The next tick opens the next round.
    await h.ctx.services.games.tick();
    expect((await h.ctx.services.games.currentRound('golden_wheel'))!.roundNo).toBe(2);
  });

  it('enforces bet limits and the per-round stake cap', async () => {
    const round = await h.ctx.services.games.currentRound('golden_wheel');
    const tooSmall = await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p1'))
      .set('Idempotency-Key', key())
      .send({ roundId: String(round!._id), option: 'cherry', amount: 1 });
    expect(tooSmall.status).toBe(400);
    const unknown = await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p1'))
      .set('Idempotency-Key', key())
      .send({ roundId: String(round!._id), option: 'banana', amount: 100 });
    expect(unknown.status).toBe(400);
  });

  it('refuses configs that would pay out more than they take', async () => {
    const cfg = {
      ...GAME_DEFINITIONS.golden_wheel.defaultConfig,
      payouts: { ...GAME_DEFINITIONS.golden_wheel.defaultConfig.payouts, cherry: 50 },
    };
    await expect(h.ctx.services.games.updateConfig('golden_wheel', cfg)).rejects.toThrow(/RTP/);
  });

  it('voids a stuck round with refunds', async () => {
    const round = await h.ctx.services.games.currentRound('golden_wheel');
    await h.api
      .post('/v1/games/golden_wheel/bets')
      .set(h.as('p2'))
      .set('Idempotency-Key', key())
      .send({ roundId: String(round!._id), option: 'melon', amount: 500 });
    const before = (await h.ctx.col.users.findOne({ _id: 'p2' }))!.wallet.diamonds;
    expect(await h.ctx.services.games.voidRound(round!._id)).toEqual({ refunded: 1 });
    expect((await h.ctx.col.users.findOne({ _id: 'p2' }))!.wallet.diamonds).toBe(before + 500);
  });
});
