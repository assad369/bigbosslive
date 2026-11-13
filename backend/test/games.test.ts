import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { removeInhouseGames } from '../scripts/remove-inhouse-games.js';
import { gameFromApi, gameUnavailable, sessionTokenOf } from '../src/infra/asadsoft.js';
import { gameLock, type GamesSettings } from '../src/modules/games/access.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
const ADMIN = () => h.as('boss', 'admin');
const STAR = 'greedy-star2';
const PATTI = 'royal-teen-patti';

beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('mod', { adminRole: 'moderator' });
  await h.user('sup', { adminRole: 'support' });
  await h.user('ana', { level: { level: 3, points: 0 }, wallet: { diamonds: 5000 } });
  await h.user('low', { level: { level: 0, points: 0 } });
});
afterAll(() => h.close());

beforeEach(async () => {
  h.asadsoft.failWith = null;
  await h.ctx.services.games.syncCatalog(null);
  await h.ctx.col.gameCatalog.updateMany(
    {},
    { $set: { enabled: true, liveRoom: true, minLevel: null, displayName: null, sortOrder: 0 } },
  );
  await h.ctx.services.games.updateSettings(
    { enabled: true, minLevel: 0, liveRoomEnabled: true, showLocked: true },
    'boss',
  );
  await h.ctx.col.users.updateMany({}, { $set: { gamesBlock: null } });
});

describe('pure helpers', () => {
  const settings: GamesSettings = {
    enabled: true,
    minLevel: 2,
    liveRoomEnabled: true,
    showLocked: true,
  };
  const user = { level: { level: 3, points: 0 }, status: 'active' as const };
  const game = {
    _id: STAR,
    provider: {
      name: 'x',
      category: 'casual',
      thumbnailUrl: null,
      sortOrder: 0,
      available: true,
      syncedAt: new Date(),
    },
    enabled: true,
    liveRoom: false,
    minLevel: null,
    sortOrder: 0,
    displayName: null,
    iconUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
  };

  it('gameLock applies the switch, the game, a block, the live room and the level', () => {
    expect(gameLock({ settings, user, game })).toBeNull();
    expect(gameLock({ settings: { ...settings, enabled: false }, user, game })).toEqual({
      reason: 'disabled',
    });
    expect(gameLock({ settings, user, game: null })).toEqual({ reason: 'disabled' });
    expect(gameLock({ settings, user, game: undefined })).toBeNull();
    expect(
      gameLock({
        settings,
        user: { ...user, gamesBlock: { at: new Date(), by: 'a', reason: 'r' } },
        game,
      }),
    ).toEqual({ reason: 'blocked' });
    expect(gameLock({ settings, user, game, inLive: true })).toEqual({ reason: 'live_off' });
    expect(gameLock({ settings, user, game: { ...game, minLevel: 4 } })).toEqual({
      reason: 'level',
      minLevel: 4,
    });
    expect(gameLock({ settings: { ...settings, minLevel: 9 }, user, game })).toMatchObject({
      reason: 'level',
      minLevel: 9,
    });
  });

  it('reads provider replies', () => {
    expect(
      gameFromApi({ gameId: 'lion3-pro', name: 'Lion 3 Pro', category: 'casual' }),
    ).toMatchObject({ gameId: 'lion3-pro', name: 'Lion 3 Pro', sortOrder: 0 });
    expect(gameFromApi({ gameId: 'Bad Id' })).toBeNull();
    expect(sessionTokenOf('https://g.test/x/?token=abc&lang=en')).toBe('abc');
    expect(sessionTokenOf('not a url')).toBeNull();
  });
});

describe('catalogue sync', () => {
  it('adds new games disabled, keeps local controls, and marks withdrawn games unavailable', async () => {
    await h.ctx.services.games.update(STAR, { displayName: 'Star', minLevel: 7 }, 'boss');
    h.asadsoft.games.push({
      gameId: 'lion3-pro',
      name: 'Lion 3 Pro',
      category: 'casual',
      thumbnailUrl: null,
      sortOrder: 3,
    });
    try {
      const res = await h.api.post('/v1/admin/games/sync').set(ADMIN());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 3, added: 1 });
      const lion = res.body.items.find((g: { gameId: string }) => g.gameId === 'lion3-pro');
      expect(lion).toMatchObject({ enabled: false, liveRoom: true, minLevel: null });
      const star = await h.ctx.col.gameCatalog.findOne({ _id: STAR });
      expect(star).toMatchObject({ displayName: 'Star', minLevel: 7, enabled: true });
    } finally {
      h.asadsoft.games.pop();
    }
    await h.ctx.services.games.syncCatalog(null);
    expect((await h.ctx.col.gameCatalog.findOne({ _id: 'lion3-pro' }))!.provider.available).toBe(
      false,
    );
    expect(await h.ctx.col.auditLogs.findOne({ action: 'game.sync' })).toBeTruthy();
  });

  it('a provider outage fails the sync loudly in the admin, quietly in the tick', async () => {
    h.asadsoft.failWith = gameUnavailable();
    expect((await h.api.post('/v1/admin/games/sync').set(ADMIN())).status).toBe(403);
    await expect(h.ctx.services.games.syncTick()).resolves.toBeUndefined();
  });
});

describe('app: list and launch', () => {
  it('lists enabled games with each lock, and nothing while games are off', async () => {
    await h.ctx.services.games.update(PATTI, { minLevel: 5 }, 'boss');
    const res = await h.api.get('/v1/games').set(h.as('ana'));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { gameId: STAR, name: 'Greedy Star 2', iconUrl: null, category: 'casual', lock: null },
      {
        gameId: PATTI,
        name: 'Royal Teen Patti',
        iconUrl: null,
        category: 'card',
        lock: { reason: 'level', minLevel: 5 },
      },
    ]);

    await h.ctx.services.games.updateSettings({ showLocked: false }, 'boss');
    expect((await h.api.get('/v1/games').set(h.as('ana'))).body.items).toHaveLength(1);

    await h.ctx.services.games.update(STAR, { enabled: false }, 'boss');
    expect((await h.api.get('/v1/games').set(h.as('ana'))).body.items).toEqual([]);

    await h.ctx.services.games.updateSettings({ enabled: false }, 'boss');
    expect((await h.api.get('/v1/games').set(h.as('ana'))).body.items).toEqual([]);
  });

  it('filters the live room list', async () => {
    await h.ctx.services.games.update(PATTI, { liveRoom: false }, 'boss');
    const live = await h.api.get('/v1/games?context=live').set(h.as('ana'));
    expect(live.body.items.map((g: { gameId: string }) => g.gameId)).toEqual([STAR]);
    await h.ctx.services.games.updateSettings({ liveRoomEnabled: false }, 'boss');
    expect((await h.api.get('/v1/games?context=live').set(h.as('ana'))).body.items).toEqual([]);
    expect((await h.api.get('/v1/games').set(h.as('ana'))).body.items).toHaveLength(2);
    const cfg = await h.api.get('/v1/config/app');
    expect(cfg.body.features).toMatchObject({ gamesEnabled: true, gamesInLive: false });
  });

  it('launches a session for the player and records it', async () => {
    const res = await h.api
      .post(`/v1/games/${STAR}/launch`)
      .set(h.as('ana'))
      .send({ context: 'live', language: 'bn' });
    expect(res.status).toBe(200);
    expect(res.body.gameUrl).toMatch(/^https:\/\/games\.asadsoft\.test\/greedy-star2\/\?token=/);
    expect(h.asadsoft.launches.at(-1)).toMatchObject({
      gameId: STAR,
      playerId: 'ana',
      playerUsername: 'User ana',
      language: 'bn',
    });
    const session = await h.ctx.col.gameSessions.findOne({ _id: res.body.sessionId });
    expect(session).toMatchObject({ uid: 'ana', gameId: STAR, inLive: true });
    expect(session!.token).toMatch(/^jwt-/);
    // An empty body launches from the Games screen.
    expect((await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana'))).status).toBe(200);
  });

  it('refuses a locked game with the reason, and maps provider refusals', async () => {
    await h.ctx.services.games.updateSettings({ minLevel: 1 }, 'boss');
    const low = await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('low')).send({});
    expect(low.status).toBe(403);
    expect(low.body.error).toMatchObject({
      code: 'game_locked',
      details: { reason: 'level', minLevel: 1 },
    });
    expect((await h.api.post('/v1/games/nope/launch').set(h.as('ana')).send({})).status).toBe(404);
    expect(
      (await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana')).send({ language: 'en&x=1' }))
        .status,
    ).toBe(422);
    h.asadsoft.failWith = gameUnavailable('Game not enabled for your account.');
    const refused = await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana')).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('game_unavailable');
  });
});

describe('admin', () => {
  it('reads with games.read, writes with games.manage, and audits writes', async () => {
    expect((await h.api.get('/v1/admin/games').set(h.as('fin', 'finance'))).status).toBe(200);
    expect((await h.api.get('/v1/admin/games').set(h.as('sup', 'support'))).status).toBe(403);
    expect(
      (
        await h.api
          .patch(`/v1/admin/games/${STAR}`)
          .set(h.as('fin', 'finance'))
          .send({ enabled: false })
      ).status,
    ).toBe(403);

    const patch = await h.api
      .patch(`/v1/admin/games/${STAR}`)
      .set(ADMIN())
      .send({ minLevel: 4, displayName: 'Star Wheel', sortOrder: 9 });
    expect(patch.status).toBe(200);
    expect(patch.body.game).toMatchObject({ name: 'Star Wheel', minLevel: 4, sortOrder: 9 });
    expect(
      await h.ctx.col.auditLogs.findOne({ action: 'game.update', targetId: STAR }),
    ).toBeTruthy();

    const settings = await h.api
      .put('/v1/admin/games/settings')
      .set(ADMIN())
      .send({ minLevel: 2, liveRoomEnabled: false });
    expect(settings.body.settings).toMatchObject({
      enabled: true,
      minLevel: 2,
      liveRoomEnabled: false,
    });
    expect(await h.ctx.col.auditLogs.findOne({ action: 'game.settings' })).toBeTruthy();

    const list = await h.api.get('/v1/admin/games').set(ADMIN());
    expect(list.body.integration).toMatchObject({
      configured: true,
      walletCallbackUrl: 'http://localhost:3000/v1/webhooks/asadsoft',
    });
    expect(
      (await h.api.get('/v1/admin/games/stats/overview').set(h.as('fin', 'finance'))).body.today,
    ).toMatchObject({ turnover: 0, players: 0 });
    expect(
      (await h.api.get('/v1/admin/games/stats/daily?from=2026-03-01&to=2026-03-15').set(ADMIN()))
        .body.items,
    ).toHaveLength(15);
    expect(
      (await h.api.get('/v1/admin/games/stats/daily?from=2026-03-15&to=2026-03-01').set(ADMIN()))
        .status,
    ).toBe(400);
  });

  it('blocks a player: launch refused, open sessions ended, audited; moderators may', async () => {
    const launched = await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana')).send({});
    const block = await h.api
      .post('/v1/admin/users/ana/games-block')
      .set(h.as('mod', 'moderator'))
      .send({ reason: 'self exclusion request' });
    expect(block.status).toBe(200);
    await h.jobs.drain();
    expect(h.asadsoft.ended.map((e) => e.sessionId)).toContain(launched.body.sessionId);
    expect(await h.ctx.col.gameSessions.findOne({ _id: launched.body.sessionId })).toBeNull();

    const refused = await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana')).send({});
    expect(refused.body.error.details).toEqual({ reason: 'blocked' });
    expect((await h.api.get('/v1/games').set(h.as('ana'))).body.items[0].lock).toEqual({
      reason: 'blocked',
    });

    const player = await h.api.get('/v1/admin/games/players/ana').set(h.as('mod', 'moderator'));
    expect(player.body.block).toMatchObject({ reason: 'self exclusion request', by: 'mod' });
    const blocked = await h.api.get('/v1/admin/games/blocked').set(ADMIN());
    expect(blocked.body.items.map((b: { uid: string }) => b.uid)).toContain('ana');
    expect(
      (
        await h.api
          .post('/v1/admin/users/ana/games-block')
          .set(h.as('sup', 'support'))
          .send({ reason: 'xyz' })
      ).status,
    ).toBe(403);

    expect((await h.api.delete('/v1/admin/users/ana/games-block').set(ADMIN())).status).toBe(204);
    expect(await h.ctx.col.auditLogs.countDocuments({ action: /^user\.games_/ })).toBe(2);
    expect((await h.api.post(`/v1/games/${STAR}/launch`).set(h.as('ana')).send({})).status).toBe(
      200,
    );
  });

  it('turning a game off ends its open sessions', async () => {
    const launched = await h.api.post(`/v1/games/${PATTI}/launch`).set(h.as('ana')).send({});
    await h.api.patch(`/v1/admin/games/${PATTI}`).set(ADMIN()).send({ enabled: false });
    await h.jobs.drain();
    expect(h.asadsoft.ended.map((e) => e.sessionId)).toContain(launched.body.sessionId);
  });
});

describe('purchases feed', () => {
  it('reports a committed recharge once', async () => {
    const { recharge } = await h.ctx.services.wallet.recharge({
      uid: 'ana',
      diamonds: 700,
      source: 'admin',
      adminId: 'boss',
      idempotencyKey: `rch-${new ObjectId()}`,
    });
    await h.jobs.drain();
    expect(h.asadsoft.purchases.filter((p) => p.purchaseId === String(recharge._id))).toEqual([
      expect.objectContaining({ playerId: 'ana', diamonds: 700, source: 'admin' }),
    ]);
  });
});

describe('migration: remove the in-house games', () => {
  it('refunds bets of unsettled rounds once, then drops the old collections', async () => {
    const raw = h.ctx.db.db;
    await h.user('old', { wallet: { diamonds: 10 } });
    const roundId = new ObjectId();
    await raw
      .collection('game_rounds')
      .insertOne({ _id: roundId, game: 'teen_patti', status: 'betting' });
    await raw.collection('game_bets').insertMany([
      { roundId, game: 'teen_patti', userId: 'old', amount: 300, status: 'placed' },
      { roundId, game: 'teen_patti', userId: 'old', amount: 50, status: 'won' },
      { roundId, game: 'teen_patti', userId: 'gone-user', amount: 40, status: 'placed' },
    ]);
    await raw.collection('games').insertOne({ _id: 'teen_patti' } as never);

    const report = await removeInhouseGames(h.ctx.db, () => h.clock.now());
    expect(report).toMatchObject({ betsRefunded: 1, diamondsRefunded: 300, betsVoided: 1 });
    expect(report.dropped.sort()).toEqual(['game_bets', 'game_rounds', 'games']);
    expect((await h.ctx.col.users.findOne({ _id: 'old' }))!.wallet.diamonds).toBe(310);
    expect(await h.ctx.col.ledger.findOne({ userId: 'old', reason: 'game_refund' })).toMatchObject({
      delta: 300,
      balanceAfter: 310,
    });
    const names = (await raw.listCollections().toArray()).map((c) => c.name);
    expect(names).not.toContain('game_bets');
    expect(names).toContain('game_catalog');

    expect(await removeInhouseGames(h.ctx.db)).toEqual({
      betsRefunded: 0,
      diamondsRefunded: 0,
      betsVoided: 0,
      dropped: [],
    });
  });
});
