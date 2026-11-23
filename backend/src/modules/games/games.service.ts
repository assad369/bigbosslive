import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import type { AdminGame, GameLaunch, GameListItem, GamesIntegrationStatus } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { GameCatalogDoc, GameSessionDoc, UserDoc } from '../../db/schema.js';
import { gamesUnavailable, sessionTokenOf } from '../../infra/asadsoft.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';
import { gameLock, lockMessage, type GamesSettings } from './access.js';

/** Our own controls on a catalogue game; provider fields only change through a sync. */
export const gamePatchInput = z
  .object({
    enabled: z.boolean(),
    liveRoom: z.boolean(),
    minLevel: z.number().int().min(0).max(999).nullable(),
    sortOrder: z.number().int().min(-10_000).max(10_000),
    displayName: z.string().trim().min(1).max(60).nullable(),
    iconUrl: z.url().max(1000).nullable(),
  })
  .partial();
export type GamePatch = z.infer<typeof gamePatchInput>;

export const gamesSettingsInput = z
  .object({
    enabled: z.boolean(),
    minLevel: z.number().int().min(0).max(999),
    liveRoomEnabled: z.boolean(),
    showLocked: z.boolean(),
  })
  .partial();

export const gamesBlockInput = z.object({ reason: z.string().trim().min(3).max(200) });

/** AsadSoft embeds the playerId in `:`-separated txIds; our uids never contain one. */
const PLAYER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type EndSessionsScope = { uid: string } | { gameId: string } | { all: true };

export class GamesService {
  constructor(private readonly ctx: Ctx) {}

  /** Launch works and the wallet callbacks can authenticate. */
  get configured(): boolean {
    const { env } = this.ctx;
    return (
      this.ctx.asadsoft.configured && Boolean(env.ASADSOFT_API_SECRET && env.ASADSOFT_WALLET_TOKEN)
    );
  }

  async settings(): Promise<GamesSettings> {
    const [features, games] = await Promise.all([
      this.ctx.services.config.get('features'),
      this.ctx.services.config.get('games'),
    ]);
    return { enabled: features.gamesEnabled, ...games };
  }

  /** Save the master switch and the global rules. Turning games off ends every open session. */
  async updateSettings(input: z.infer<typeof gamesSettingsInput>, adminId: string) {
    const { config } = this.ctx.services;
    const before = await this.settings();
    if (input.enabled !== undefined && input.enabled !== before.enabled) {
      const features = await config.get('features');
      await config.set('features', { ...features, gamesEnabled: input.enabled }, adminId);
    }
    const { enabled: _enabled, ...rules } = input;
    if (Object.keys(rules).length > 0) {
      const current = await config.get('games');
      await config.set('games', { ...current, ...rules }, adminId);
    }
    const after = await this.settings();
    if (before.enabled && !after.enabled) await this.endSessions({ all: true });
    return after;
  }

  // ── App ───────────────────────────────────────────────────────────────────

  /** Games the app shows, each with its lock for this player. */
  async list(user: UserDoc, opts: { inLive: boolean }): Promise<GameListItem[]> {
    const settings = await this.settings();
    if (!settings.enabled || (opts.inLive && !settings.liveRoomEnabled)) return [];
    const games = await this.ctx.col.gameCatalog
      .find({
        enabled: true,
        'provider.available': true,
        ...(opts.inLive ? { liveRoom: true } : {}),
      })
      .sort({ sortOrder: 1, _id: 1 })
      .toArray();
    return games
      .map((g) => ({
        gameId: g._id,
        name: g.displayName ?? g.provider.name,
        iconUrl: g.iconUrl,
        category: g.provider.category,
        lock: gameLock({ settings, user, game: g, inLive: opts.inLive }),
      }))
      .filter((g) => settings.showLocked || g.lock?.reason !== 'level');
  }

  /** Open a provider session for `user`. The returned URL carries a 4-hour session token. */
  async launch(
    user: UserDoc,
    gameId: string,
    opts: { inLive: boolean; language: string },
  ): Promise<GameLaunch> {
    if (!this.configured) throw gamesUnavailable('Games are not available right now');
    const [settings, game] = await Promise.all([
      this.settings(),
      this.ctx.col.gameCatalog.findOne({ _id: gameId }),
    ]);
    if (!game) throw notFound('Game');
    const lock = gameLock({ settings, user, game, inLive: opts.inLive });
    if (lock) throw new AppError(403, 'game_locked', lockMessage(lock), lock);
    if (!PLAYER_ID.test(user._id)) throw badRequest('This account cannot play games');

    const launched = await this.ctx.asadsoft.launch({
      gameId,
      playerId: user._id,
      playerUsername: user.displayName.slice(0, 40),
      playerAvatar: user.avatarUrl,
      language: opts.language,
    });
    let url: URL;
    try {
      url = new URL(launched.gameUrl);
    } catch {
      throw gamesUnavailable('The game server sent an invalid game address');
    }
    if (this.ctx.env.NODE_ENV === 'production' && url.protocol !== 'https:')
      throw gamesUnavailable('The game server sent an insecure game address');

    const token = sessionTokenOf(launched.gameUrl);
    if (token) {
      await this.ctx.col.gameSessions
        .updateOne(
          { _id: launched.sessionId },
          {
            $set: {
              uid: user._id,
              gameId,
              token,
              inLive: opts.inLive,
              createdAt: this.ctx.clock.now(),
              expiresAt: launched.expiresAt,
            },
          },
          { upsert: true },
        )
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'game session not recorded'));
    }
    return {
      gameUrl: launched.gameUrl,
      sessionId: launched.sessionId,
      expiresAt: launched.expiresAt.toISOString(),
    };
  }

  // ── Admin: catalogue ──────────────────────────────────────────────────────

  async catalog(): Promise<AdminGame[]> {
    const games = await this.ctx.col.gameCatalog.find().sort({ sortOrder: 1, _id: 1 }).toArray();
    return games.map(toAdminGame);
  }

  /**
   * Pull the operator's catalogue from AsadSoft. New games arrive disabled; a game the provider
   * stops listing is marked unavailable (hidden, and its stakes refused) but kept with its
   * settings. Local controls are never overwritten.
   */
  async syncCatalog(actor: string | null) {
    const games = await this.ctx.asadsoft.listGames();
    const now = this.ctx.clock.now();
    let added = 0;
    for (const g of games) {
      const res = await this.ctx.col.gameCatalog.updateOne(
        { _id: g.gameId },
        {
          $set: {
            provider: {
              name: g.name,
              category: g.category,
              thumbnailUrl: g.thumbnailUrl,
              sortOrder: g.sortOrder,
              available: true,
              syncedAt: now,
            },
          },
          $setOnInsert: {
            enabled: false,
            liveRoom: true,
            minLevel: null,
            sortOrder: g.sortOrder,
            displayName: null,
            iconUrl: null,
            createdAt: now,
            updatedAt: now,
            updatedBy: actor,
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount) added++;
    }
    const listed = games.map((g) => g.gameId);
    const gone = await this.ctx.col.gameCatalog.updateMany(
      { _id: { $nin: listed }, 'provider.available': true },
      { $set: { 'provider.available': false, 'provider.syncedAt': now } },
    );
    return { total: games.length, added, unavailable: gone.modifiedCount };
  }

  /** The hourly tick: a sync that never throws (the provider may be down). */
  async syncTick(): Promise<void> {
    if (!this.ctx.asadsoft.configured) return;
    await this.syncCatalog(null).catch((err: unknown) =>
      this.ctx.log.warn({ err }, 'games catalogue sync failed'),
    );
  }

  async update(gameId: string, patch: GamePatch, adminId: string): Promise<AdminGame> {
    const before = await this.ctx.col.gameCatalog.findOne({ _id: gameId });
    if (!before) throw notFound('Game');
    const after = await this.ctx.col.gameCatalog.findOneAndUpdate(
      { _id: gameId },
      { $set: { ...patch, updatedAt: this.ctx.clock.now(), updatedBy: adminId } },
      { returnDocument: 'after' },
    );
    if (!after) throw notFound('Game');
    if (before.enabled && !after.enabled) await this.endSessions({ gameId });
    return toAdminGame(after);
  }

  // ── Admin: players ────────────────────────────────────────────────────────

  async block(uid: string, reason: string, adminId: string) {
    const block = { at: this.ctx.clock.now(), by: adminId, reason };
    const res = await this.ctx.col.users.updateOne(
      { _id: uid, status: { $ne: 'deleted' } },
      { $set: { gamesBlock: block } },
    );
    if (!res.matchedCount) throw notFound('User');
    await this.endSessions({ uid });
    return block;
  }

  async unblock(uid: string) {
    const res = await this.ctx.col.users.updateOne({ _id: uid }, { $set: { gamesBlock: null } });
    if (!res.matchedCount) throw notFound('User');
  }

  async blocked(opts: { cursor?: string; limit: number }) {
    const q = {
      gamesBlock: { $type: 'object' },
      ...afterCursor(opts.cursor, 'gamesBlock.at', true),
    } as Filter<UserDoc>;
    const rows = await this.ctx.col.users
      .find(q)
      .sort({ 'gamesBlock.at': -1, _id: -1 })
      .limit(opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const briefs = await this.ctx.services.users.briefs(page.map((u) => u._id));
    const last = page.at(-1);
    return {
      items: page.map((u) => ({
        uid: u._id,
        user: briefs.get(u._id) ?? null,
        block: {
          at: u.gamesBlock!.at.toISOString(),
          by: u.gamesBlock!.by,
          reason: u.gamesBlock!.reason,
        },
      })),
      nextCursor:
        rows.length > opts.limit && last ? encodeCursor(last.gamesBlock!.at, last._id) : null,
    };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * End the matching open sessions in the background, so their WebViews close with
   * `SESSION_INVALID`. Best-effort: the stake gate is what enforces a block or a switch.
   */
  async endSessions(scope: EndSessionsScope): Promise<void> {
    await this.ctx.jobs
      .enqueue('games.end_sessions', scope)
      .catch((err: unknown) => this.ctx.log.warn({ err, scope }, 'games.end_sessions not queued'));
  }

  async runEndSessions(scope: EndSessionsScope): Promise<number> {
    const q: Filter<GameSessionDoc> = { expiresAt: { $gt: this.ctx.clock.now() } };
    if ('uid' in scope) q.uid = scope.uid;
    if ('gameId' in scope) q.gameId = scope.gameId;
    let ended = 0;
    for await (const s of this.ctx.col.gameSessions.find(q).limit(5000)) {
      try {
        await this.ctx.asadsoft.endSession(s._id, s.token);
      } catch (err) {
        // Already ended or expired on their side: nothing left to close.
        this.ctx.log.debug({ err, sessionId: s._id }, 'game session end failed');
      }
      await this.ctx.col.gameSessions.deleteOne({ _id: s._id });
      ended++;
    }
    return ended;
  }

  // ── Purchases feed ────────────────────────────────────────────────────────

  /** Queue a committed recharge for AsadSoft's hold-against-purchases report. Never throws. */
  async queuePurchase(rechargeId: ObjectId): Promise<void> {
    if (!this.ctx.asadsoft.configured) return;
    await this.ctx.jobs
      .enqueue('games.purchase', { rechargeId: String(rechargeId) })
      .catch((err: unknown) => this.ctx.log.warn({ err }, 'games.purchase not queued'));
  }

  async reportPurchase(rechargeId: string): Promise<void> {
    if (!this.ctx.asadsoft.configured) return;
    const r = await this.ctx.col.recharges.findOne({ _id: new ObjectId(rechargeId) });
    if (!r) return;
    await this.ctx.asadsoft.reportPurchases([
      {
        purchaseId: String(r._id),
        playerId: r.userId,
        diamonds: r.diamonds,
        purchasedAt: r.createdAt,
        source: r.source,
      },
    ]);
  }

  // ── Integration status ────────────────────────────────────────────────────

  async integration(): Promise<GamesIntegrationStatus> {
    const [lastSync, lastCallback, catalogSize, enabledCount] = await Promise.all([
      this.ctx.col.gameCatalog.find().sort({ 'provider.syncedAt': -1 }).limit(1).next(),
      this.ctx.col.gameWalletTxs.find().sort({ createdAt: -1, _id: -1 }).limit(1).next(),
      this.ctx.col.gameCatalog.countDocuments(),
      this.ctx.col.gameCatalog.countDocuments({ enabled: true, 'provider.available': true }),
    ]);
    return {
      configured: this.configured,
      apiUrl: this.ctx.env.ASADSOFT_API_URL ?? null,
      walletCallbackUrl: `${this.ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v1/webhooks/asadsoft`,
      lastSyncAt: lastSync?.provider.syncedAt.toISOString() ?? null,
      lastCallbackAt: lastCallback?.createdAt.toISOString() ?? null,
      catalogSize,
      enabledCount,
    };
  }
}

export function toAdminGame(g: GameCatalogDoc): AdminGame {
  return {
    gameId: g._id,
    name: g.displayName ?? g.provider.name,
    displayName: g.displayName,
    iconUrl: g.iconUrl,
    provider: {
      name: g.provider.name,
      category: g.provider.category,
      available: g.provider.available,
      syncedAt: g.provider.syncedAt?.toISOString() ?? null,
    },
    enabled: g.enabled,
    liveRoom: g.liveRoom,
    minLevel: g.minLevel,
    sortOrder: g.sortOrder,
    updatedAt: g.updatedAt?.toISOString() ?? null,
  };
}
