import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asadsoftWalletRoutes, signWalletBody } from '../src/routes/asadsoft-wallet.js';
import { counterDelta, kindOf } from '../src/modules/games/game-wallet.service.js';
import { moneyOf, shiftDay } from '../src/modules/games/games-stats.service.js';
import { ASADSOFT_TEST_ENV, createHarness, type Harness } from './helpers/harness.js';

/**
 * The AsadSoft wallet contract. Each case here is one of the losses the provider's
 * `npm run wallet:conformance` check exists to catch, plus our own rules (who may stake,
 * level never moves, stats reconcile).
 */

let h: Harness;
const SECRET = ASADSOFT_TEST_ENV.ASADSOFT_API_SECRET;
const TOKEN = ASADSOFT_TEST_ENV.ASADSOFT_WALLET_TOKEN;
const GAME = 'greedy-star2';
let seq = 0;

beforeAll(async () => {
  h = await createHarness();
  await h.ctx.services.games.syncCatalog(null);
  await h.ctx.services.games.update(GAME, { enabled: true }, 'admin');
});
afterAll(() => h.close());

/** A fresh player per test, holding `diamonds`. */
let player: string;
beforeEach(async () => {
  player = `p${++seq}`;
  await h.user(player, { wallet: { diamonds: 1000 }, level: { level: 5, points: 0 } });
});

function call(
  type: 'debit' | 'credit',
  body: Record<string, unknown>,
  opts: { signature?: string; token?: string } = {},
) {
  // Shaped and ordered as AsadSoft's `_buildPayload` sends it.
  const raw = JSON.stringify({
    playerId: player,
    gameId: GAME,
    sessionId: 'sess-1',
    ...body,
    currency: 'DIAMOND',
    platform: 'asadsoft-games',
    timestamp: new Date().toISOString(),
  });
  return h.api
    .post(`/v1/webhooks/asadsoft/${type}`)
    .set('Authorization', `Bearer ${opts.token ?? TOKEN}`)
    .set('Content-Type', 'application/json')
    .set('X-Signature', opts.signature ?? signWalletBody(raw, SECRET))
    .send(raw);
}

const stake = (txId: string, amount: number, extra: Record<string, unknown> = {}) =>
  call('debit', { amount, txId, roundId: `r1:${player}`, ...extra });
const credit = (txId: string, amount: number, extra: Record<string, unknown> = {}) =>
  call('credit', { amount, txId, roundId: `r1:${player}`, ...extra });

async function diamonds(uid = player) {
  return (await h.ctx.col.users.findOne({ _id: uid }))!.wallet.diamonds;
}

describe('pure helpers', () => {
  it('kindOf follows the provider txId table', () => {
    expect(kindOf('debit', 'stake:r:p:u')).toBe('stake');
    expect(kindOf('debit', 'bet:r')).toBe('stake');
    expect(kindOf('credit', 'win:g')).toBe('win');
    expect(kindOf('credit', 'refund:stake:r:p:u')).toBe('refund');
    expect(kindOf('credit', 'cancel:stake:r:p:u')).toBe('refund');
    expect(kindOf('credit', 'cashback:g')).toBe('cashback');
    expect(kindOf('credit', 'x', 'loss_cashback')).toBe('cashback');
    expect(kindOf('credit', 'wager-rebate:g')).toBe('rebate');
    expect(kindOf('debit', 'reverse:win:r')).toBe('reversal');
    expect(kindOf('debit', 'xfer-in:t')).toBe('transfer_in');
    expect(kindOf('credit', 'xfer-out:t')).toBe('transfer_out');
    expect(kindOf('debit', 'mystery')).toBe('other_debit');
  });

  it('counterDelta nets a reversal out of the kind it reverses', () => {
    expect(counterDelta('stake', 'debit', 100, false)).toMatchObject({
      stakes: 100,
      stakeCount: 1,
      net: 100,
      debited: 100,
    });
    expect(counterDelta('stake', 'credit', 40, true)).toMatchObject({
      stakes: -40,
      net: -40,
      refunds: 40,
      credited: 40,
    });
    expect(counterDelta('win', 'debit', 30, true)).toMatchObject({
      wins: -30,
      net: 30,
      reversals: 30,
    });
  });

  it('moneyOf and shiftDay', () => {
    expect(moneyOf({ stakes: 100, wins: 50, cashback: 2 })).toMatchObject({
      turnover: 100,
      payouts: 50,
      ggr: 48,
      rtp: 0.52,
    });
    expect(moneyOf({}).rtp).toBeNull();
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2024-12-31', 1)).toBe('2025-01-01');
  });
});

describe('authentication', () => {
  it('refuses a missing or wrong token, and a missing or bad signature', async () => {
    const noToken = await h.api.get(`/v1/webhooks/asadsoft/balance?playerId=${player}`);
    expect(noToken.status).toBe(401);
    expect((await stake('stake:a', 10, {}).set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await stake('stake:b', 10, {}).set('X-Signature', 'deadbeef')).status).toBe(401);
    const forged = await credit('win:forged', 500, {}).set(
      'X-Signature',
      signWalletBody('{}', SECRET),
    );
    expect(forged.status).toBe(401);
    expect(forged.body).toEqual({ success: false, error: 'INVALID_SIGNATURE' });
    expect(await diamonds()).toBe(1000);
    expect(await h.ctx.col.gameWalletTxs.countDocuments({ uid: player })).toBe(0);
  });

  it('fails closed when the secret or token is not configured', async () => {
    const app = express();
    app.use(
      '/w',
      asadsoftWalletRoutes({
        ...h.ctx,
        env: { ...h.ctx.env, ASADSOFT_API_SECRET: undefined, ASADSOFT_WALLET_TOKEN: undefined },
      }),
    );
    const res = await supertest(app)
      .get(`/w/balance?playerId=${player}`)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});

describe('balance', () => {
  it('reports diamonds, and 404 for an unknown player', async () => {
    const res = await h.api
      .get(`/v1/webhooks/asadsoft/balance?playerId=${player}`)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      balance: 1000,
      data: { playerId: player, balance: 1000, currency: 'DIAMOND' },
    });
    const missing = await h.api
      .get('/v1/webhooks/asadsoft/balance?playerId=ghost')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(missing.status).toBe(404);
  });
});

describe('debit and credit', () => {
  it('debits a stake once, with a game ledger row, never touching level', async () => {
    const before = (await h.ctx.col.users.findOne({ _id: player }))!;
    const res = await stake(`stake:r1:${player}:u1`, 100);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      balance: 900,
      data: { playerId: player, balance: 900, deducted: 100, roundId: `r1:${player}` },
    });
    // A retry answers exactly the same and moves nothing.
    const again = await stake(`stake:r1:${player}:u1`, 100);
    expect(again.status).toBe(200);
    expect(again.body.data.deducted).toBe(100);
    expect(await diamonds()).toBe(900);

    const ledger = await h.ctx.col.ledger.find({ userId: player }).toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: 'game_bet', delta: -100, balanceAfter: 900 });
    const after = (await h.ctx.col.users.findOne({ _id: player }))!;
    expect(after.level).toEqual(before.level);
    expect(after.stats.totalRecharged).toBe(before.stats.totalRecharged);
    expect(after.stats.totalSent).toBe(before.stats.totalSent);
  });

  it('pays a retried win once, even when the retries arrive together', async () => {
    const first = await credit('win:g1', 250, { gameRoundId: 'g1' });
    expect(first.body).toMatchObject({ success: true, balance: 1250 });
    expect((await credit('win:g1', 250)).body.data.credited).toBe(250);
    const burst = await Promise.all(Array.from({ length: 8 }, () => credit('win:g2', 10)));
    for (const r of burst) expect(r.status).toBe(200);
    expect(await diamonds()).toBe(1260);
    expect(await h.ctx.col.ledger.countDocuments({ userId: player, reason: 'game_payout' })).toBe(
      2,
    );
  });

  it('never lets two concurrent stakes spend one balance', async () => {
    const [a, b] = await Promise.all([stake('stake:c:a', 600), stake('stake:c:b', 600)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 402]);
    expect(await diamonds()).toBe(400);
    const refused = a.status === 402 ? a : b;
    expect(refused.body).toEqual({ success: false, error: 'INSUFFICIENT_BALANCE' });
    // The refusal is remembered: a retry of that txId is refused the same way, even with funds.
    await h.ctx.col.users.updateOne({ _id: player }, { $inc: { 'wallet.diamonds': 1000 } });
    const txId = a.status === 402 ? 'stake:c:a' : 'stake:c:b';
    expect((await stake(txId, 600)).status).toBe(402);
  });

  it('refunds at most the stake, once', async () => {
    await stake('stake:d:1', 10);
    const refund = await credit('refund:stake:d:1', 25, { refTxId: 'stake:d:1' });
    expect(refund.body.data.credited).toBe(10);
    const second = await credit('cancel:stake:d:1', 10, { refTxId: 'stake:d:1' });
    expect(second.status).toBe(200);
    expect(second.body.data.credited).toBe(0);
    expect(await diamonds()).toBe(1000);
    const original = await h.ctx.col.gameWalletTxs.findOne({ _id: 'stake:d:1' });
    expect(original).toMatchObject({ status: 'reversed', reversedBy: 'refund:stake:d:1' });
  });

  it('a cancel for a stake never seen pays nothing, and the stake is refused when it lands', async () => {
    const cancel = await credit('cancel:stake:e:1', 50, { refTxId: 'stake:e:1' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.credited).toBe(0);
    const late = await stake('stake:e:1', 50);
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ success: false, error: 'TX_VOIDED' });
    expect(await diamonds()).toBe(1000);
  });

  it('floors a fractional payout and refuses a fractional stake', async () => {
    expect((await credit('win:h1', 0.5)).body.data.credited).toBe(0);
    expect((await credit('win:h2', 202.5)).body.data.credited).toBe(202);
    expect(await diamonds()).toBe(1202);
    expect((await stake('stake:h:3', 10.5)).status).toBe(400);
  });

  it('claws back what is left of an unsettled win and records the shortfall', async () => {
    await credit('win:k1', 100);
    await stake('stake:k:2', 1070); // 1100 → 30 left
    const res = await call('debit', { amount: 100, txId: 'reverse:win:k1', refTxId: 'win:k1' });
    expect(res.status).toBe(200);
    expect(res.body.data.deducted).toBe(30);
    expect(await diamonds()).toBe(0);
    expect(await h.ctx.col.gameWalletTxs.findOne({ _id: 'reverse:win:k1' })).toMatchObject({
      applied: 30,
      shortfall: 70,
    });
  });

  it('a reversal by another player or of the same direction moves nothing', async () => {
    await stake('stake:m:1', 100);
    const other = `${player}-other`;
    await h.user(other, { wallet: { diamonds: 0 } });
    const foreign = await call('credit', {
      playerId: other,
      amount: 100,
      txId: 'refund:stake:m:1',
      refTxId: 'stake:m:1',
    });
    expect(foreign.body.data.credited).toBe(0);
    expect(await diamonds(other)).toBe(0);
    const sameWay = await stake('reverse:stake:m:1', 100, { refTxId: 'stake:m:1' });
    expect(sameWay.body.data.deducted).toBe(0);
    expect(await diamonds()).toBe(900);
  });
});

describe('who may stake', () => {
  it('refuses new stakes while games are off, but still pays wins and refunds', async () => {
    await stake('stake:n:1', 100);
    await h.ctx.services.games.updateSettings({ enabled: false }, 'admin');
    try {
      const refused = await stake('stake:n:2', 100);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('GAMES_DISABLED');
      expect((await credit('refund:stake:n:1', 100, { refTxId: 'stake:n:1' })).status).toBe(200);
      expect((await credit('win:n3', 40)).status).toBe(200);
      expect(await diamonds()).toBe(1040);
    } finally {
      await h.ctx.services.games.updateSettings({ enabled: true }, 'admin');
    }
  });

  it('refuses a blocked player, a low level and a disabled game', async () => {
    await h.ctx.services.games.block(player, 'responsible gaming', 'admin');
    expect((await stake('stake:o:1', 10)).body.error).toBe('PLAYER_BLOCKED');
    expect((await credit('win:o2', 10)).status).toBe(200);
    await h.ctx.services.games.unblock(player);

    await h.ctx.services.games.update(GAME, { minLevel: 6 }, 'admin');
    expect((await stake('stake:o:3', 10)).body.error).toBe('LEVEL_TOO_LOW');
    await h.ctx.services.games.update(GAME, { minLevel: null }, 'admin');

    expect((await stake('stake:o:4', 10, { gameId: 'royal-teen-patti' })).body.error).toBe(
      'GAME_DISABLED',
    );
    expect((await stake('stake:o:5', 10, { gameId: 'not-in-catalog' })).body.error).toBe(
      'GAME_DISABLED',
    );
    expect((await stake('stake:o:6', 10)).status).toBe(200);
  });
});

describe('stats', () => {
  it('reconcile to the wallet calls, net of reversals', async () => {
    const day = h.clock.now().toISOString().slice(0, 10); // the harness reports in UTC
    // A second apart, so the transaction list's order is the order they happened in.
    const steps = [
      () => stake('stake:s:1', 100, { roundId: `rs:${player}` }),
      () => stake('stake:s:2', 50, { roundId: `rs:${player}` }),
      () => credit('refund:stake:s:2', 50, { refTxId: 'stake:s:2' }),
      () => credit('win:s3', 300, { gameRoundId: 's3' }),
      () => credit('cashback:s4', 2, { reason: 'loss_cashback' }),
    ];
    for (const step of steps) {
      expect((await step()).status).toBe(200);
      h.clock.advance(1);
    }

    const summary = await h.ctx.services.gamesStats.player(player);
    expect(summary.today).toMatchObject({
      turnover: 100,
      payouts: 300,
      cashback: 2,
      ggr: -202,
      playerNet: 202,
      refunds: 50,
      stakeCount: 2,
      netFlow: -202,
    });
    expect(summary.lifetime.ggr).toBe(-202);

    const rows = await h.ctx.col.gamePlayerDays.find({ uid: player }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day, gameId: GAME, stakes: 100, wins: 300, net: -202 });

    const top = await h.ctx.services.gamesStats.topPlayers(day, day, 'winners');
    expect(top.find((t) => t.uid === player)?.playerNet).toBe(202);

    const tx = await h.ctx.services.gamesStats.transactions({ user: player, limit: 2 });
    expect(tx.items).toHaveLength(2);
    expect(tx.items[0]!.txId).toBe('cashback:s4');
    const next = await h.ctx.services.gamesStats.transactions({
      user: player,
      limit: 10,
      cursor: tx.nextCursor!,
    });
    expect(next.items.map((t) => t.txId)).toEqual(['refund:stake:s:2', 'stake:s:2', 'stake:s:1']);
    expect(tx.items[1]!.txId).toBe('win:s3');
  });
});
