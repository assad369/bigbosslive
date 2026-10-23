import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { GAME_KEYS, SOCKET, type GameKey, type GameRound } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { GameConfig, GameDoc, GameRoundDoc } from '../../db/schema.js';
import { AppError, badRequest, forbidden, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { addSeconds } from '../../lib/time.js';
import { GAME_DEFINITIONS, theoreticalRtp } from './definitions.js';
import { hashSeed, newServerSeed } from './rng.js';

export const gameConfigInput = z.object({
  bettingSeconds: z.number().int().min(5).max(120),
  revealSeconds: z.number().int().min(3).max(60),
  minBet: z.number().int().min(1),
  maxBet: z.number().int().min(1),
  maxRoundStake: z.number().int().min(1),
  chips: z.array(z.number().int().positive()).min(1).max(8),
  payouts: z.record(z.string(), z.number().positive().max(1000)),
  weights: z.record(z.string(), z.number().min(0)),
});

export const gameMetaInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  enabled: z.boolean().optional(),
  url: z.url().optional(),
  iconUrl: z.url().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const placeBetInput = z.object({
  roundId: z.string().regex(/^[a-f0-9]{24}$/i),
  option: z.string().min(1).max(32),
  amount: z.number().int().positive(),
});

const gameRoom = (game: GameKey) => `game:${game}`;

/**
 * Server-authoritative betting games with a shared round engine:
 *   betting (bets accepted) → locked (outcome computed, animation plays) → settled (payouts).
 * The engine is driven by a once-a-second tick job; every transition is a conditional update
 * so concurrent ticks (multiple replicas, retries) are harmless. Settlement is per bet and
 * conditional on `status: 'placed'`, so a crash mid-settlement resumes without double payout.
 */
export class GamesService {
  constructor(private readonly ctx: Ctx) {}

  toRound(r: GameRoundDoc): GameRound {
    return {
      id: String(r._id),
      game: r.game,
      roundNo: r.roundNo,
      status: r.status,
      serverSeedHash: r.serverSeedHash,
      serverSeed: r.status === 'settled' ? r.serverSeed : null,
      options: r.options,
      totals: r.totals,
      outcome: r.status === 'betting' ? null : r.outcome,
      bettingEndsAt: r.bettingEndsAt.toISOString(),
      settlesAt: r.settlesAt.toISOString(),
    };
  }

  /** Make sure every known game has a registry document. Idempotent; run at boot. */
  async ensureRegistry(): Promise<void> {
    const now = this.ctx.clock.now();
    for (const [i, key] of GAME_KEYS.entries()) {
      const def = GAME_DEFINITIONS[key];
      await this.ctx.col.games.updateOne(
        { _id: key },
        {
          $setOnInsert: {
            _id: key,
            name: def.name,
            enabled: false,
            url: `${this.ctx.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/games/${key.replace('_', '-')}/`,
            iconUrl: null,
            sortOrder: i,
            config: def.defaultConfig,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }
  }

  async registry(includeDisabled = false): Promise<GameDoc[]> {
    const features = await this.ctx.services.config.get('features');
    if (!features.gamesEnabled && !includeDisabled) return [];
    return this.ctx.col.games.find(includeDisabled ? {} : { enabled: true }).sort({ sortOrder: 1 }).toArray();
  }

  async game(key: GameKey): Promise<GameDoc> {
    const g = await this.ctx.col.games.findOne({ _id: key });
    if (!g) throw notFound('Game');
    return g;
  }

  async updateMeta(key: GameKey, patch: z.infer<typeof gameMetaInput>): Promise<GameDoc> {
    const res = await this.ctx.col.games.findOneAndUpdate({ _id: key }, { $set: { ...patch, updatedAt: this.ctx.clock.now() } }, { returnDocument: 'after' });
    if (!res) throw notFound('Game');
    return res;
  }

  /** New config applies from the next round; the open round keeps its options and payouts. */
  async updateConfig(key: GameKey, config: GameConfig): Promise<GameDoc> {
    const def = GAME_DEFINITIONS[key];
    const options = Object.keys(def.defaultConfig.payouts).sort();
    if (Object.keys(config.payouts).sort().join() !== options.join() || Object.keys(config.weights).sort().join() !== options.join()) {
      throw badRequest(`Payouts and weights must define exactly: ${options.join(', ')}`);
    }
    if (config.minBet > config.maxBet) throw badRequest('minBet cannot exceed maxBet');
    if (config.chips.some((c) => c < config.minBet || c > config.maxBet)) throw badRequest('Chips must be within min/max bet');
    if (Object.values(config.weights).every((w) => w === 0)) throw badRequest('At least one weight must be positive');
    const rtp = theoreticalRtp(config);
    if (key !== 'teen_patti' && Object.values(rtp).some((r) => r > 1)) {
      throw badRequest('Config would pay out more than it takes in (RTP > 100%)', rtp);
    }
    const res = await this.ctx.col.games.findOneAndUpdate({ _id: key }, { $set: { config, updatedAt: this.ctx.clock.now() } }, { returnDocument: 'after' });
    if (!res) throw notFound('Game');
    return res;
  }

  async currentRound(key: GameKey): Promise<GameRoundDoc | null> {
    return this.ctx.col.gameRounds.findOne({ game: key }, { sort: { roundNo: -1 } });
  }

  async state(key: GameKey, uid: string) {
    const game = await this.game(key);
    const round = await this.currentRound(key);
    const [myBets, wallet, recent] = await Promise.all([
      round ? this.ctx.col.gameBets.find({ roundId: round._id, userId: uid }).toArray() : Promise.resolve([]),
      this.ctx.services.wallet.balances(uid),
      this.ctx.col.gameRounds.find({ game: key, status: 'settled' }).sort({ roundNo: -1 }).limit(20).project<{ roundNo: number; outcome: string }>({ roundNo: 1, outcome: 1 }).toArray(),
    ]);
    const mine: Record<string, number> = {};
    for (const b of myBets) mine[b.option] = (mine[b.option] ?? 0) + b.amount;
    return {
      game: { key: game._id, name: game.name, enabled: game.enabled, chips: game.config.chips, payouts: game.config.payouts, minBet: game.config.minBet, maxBet: game.config.maxBet },
      round: round ? this.toRound(round) : null,
      myBets: mine,
      diamonds: wallet.diamonds,
      history: recent.map((r) => ({ roundNo: r.roundNo, outcome: r.outcome })),
      serverTime: this.ctx.clock.now().toISOString(),
    };
  }

  async placeBet(uid: string, key: GameKey, rawKey: string, input: z.infer<typeof placeBetInput>) {
    const [game, features] = await Promise.all([this.game(key), this.ctx.services.config.get('features')]);
    if (!game.enabled || !features.gamesEnabled) throw forbidden('This game is unavailable');
    const roundId = new ObjectId(input.roundId);
    const now = this.ctx.clock.now();
    const round = await this.ctx.col.gameRounds.findOne({ _id: roundId, game: key });
    if (!round) throw notFound('Round');
    if (round.status !== 'betting' || round.bettingEndsAt <= now) throw new AppError(409, 'betting_closed', 'Betting is closed for this round');
    if (!round.options.includes(input.option)) throw badRequest('Unknown option');
    const { config } = game;
    if (input.amount < config.minBet || input.amount > config.maxBet) {
      throw badRequest(`Bet must be between ${config.minBet} and ${config.maxBet}`);
    }

    const idempotencyKey = `${uid}:${rawKey}`;
    const existing = await this.ctx.col.gameBets.findOne({ idempotencyKey });
    if (existing) return { betId: String(existing._id), diamonds: (await this.ctx.services.wallet.balances(uid)).diamonds, replayed: true };

    let diamonds: number;
    let betId: ObjectId;
    try {
      ({ diamonds, betId } = await this.ctx.db.withTransaction(async (session) => {
        const staked = await this.ctx.col.gameBets
          .aggregate<{ total: number }>([{ $match: { roundId, userId: uid } }, { $group: { _id: null, total: { $sum: '$amount' } } }], { session })
          .toArray();
        if ((staked[0]?.total ?? 0) + input.amount > config.maxRoundStake) {
          throw badRequest(`You can stake at most ${config.maxRoundStake} per round`);
        }
        // Re-check the round inside the transaction: the bet and the lock cannot interleave.
        const open = await this.ctx.col.gameRounds.updateOne(
          { _id: roundId, status: 'betting', bettingEndsAt: { $gt: now } },
          { $inc: { [`totals.${input.option}`]: input.amount, betCount: 1 } },
          { session },
        );
        if (!open.modifiedCount) throw new AppError(409, 'betting_closed', 'Betting is closed for this round');
        const { insertedId } = await this.ctx.col.gameBets.insertOne(
          { roundId, game: key, userId: uid, option: input.option, amount: input.amount, payout: 0, status: 'placed', idempotencyKey, createdAt: now, settledAt: null },
          { session },
        );
        const balance = await this.ctx.services.wallet.debit(session, {
          uid,
          currency: 'diamonds',
          amount: input.amount,
          reason: 'game_bet',
          refId: String(insertedId),
          meta: { game: key, roundNo: round.roundNo, option: input.option },
        });
        return { diamonds: balance, betId: insertedId };
      }));
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const raced = await this.ctx.col.gameBets.findOne({ idempotencyKey });
        if (raced) return { betId: String(raced._id), diamonds: (await this.ctx.services.wallet.balances(uid)).diamonds, replayed: true };
      }
      throw err;
    }
    const totals = await this.ctx.col.gameRounds.findOne({ _id: roundId }, { projection: { totals: 1 } });
    this.ctx.realtime.toRoom(SOCKET.namespaces.games, gameRoom(key), SOCKET.games.totals, { roundId: input.roundId, totals: totals?.totals ?? {} });
    return { betId: String(betId), diamonds, replayed: false };
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  /** Advance every enabled game by one step. Safe to call concurrently and repeatedly. */
  async tick(): Promise<void> {
    const games = await this.ctx.col.games.find({ enabled: true }).toArray();
    const features = await this.ctx.services.config.get('features');
    for (const game of games) {
      try {
        await this.advance(game, features.gamesEnabled);
      } catch (err) {
        this.ctx.log.error({ err, game: game._id }, 'game tick failed');
      }
    }
  }

  private async advance(game: GameDoc, open: boolean): Promise<void> {
    const now = this.ctx.clock.now();
    const round = await this.currentRound(game._id);

    if (round?.status === 'betting' && round.bettingEndsAt <= now) {
      const { outcome, reveal } = GAME_DEFINITIONS[game._id].resolve(round.serverSeed, round.roundNo, game.config);
      const locked = await this.ctx.col.gameRounds.findOneAndUpdate(
        { _id: round._id, status: 'betting' },
        { $set: { status: 'locked', outcome, reveal } },
        { returnDocument: 'after' },
      );
      if (locked) this.emitRound(locked, { reveal });
      return;
    }
    if (round?.status === 'locked' && round.settlesAt <= now) {
      await this.settle(round, game.config);
      return;
    }
    if ((!round || round.status === 'settled') && open) {
      await this.openRound(game, (round?.roundNo ?? 0) + 1);
    }
  }

  private async openRound(game: GameDoc, roundNo: number): Promise<void> {
    const now = this.ctx.clock.now();
    const { seed, hash } = newServerSeed();
    const bettingEndsAt = addSeconds(now, game.config.bettingSeconds);
    const doc: GameRoundDoc = {
      _id: new ObjectId(),
      game: game._id,
      roundNo,
      status: 'betting',
      serverSeedHash: hash,
      serverSeed: seed,
      options: Object.keys(game.config.payouts),
      totals: Object.fromEntries(Object.keys(game.config.payouts).map((k) => [k, 0])),
      betCount: 0,
      outcome: null,
      reveal: null,
      payoutTotal: 0,
      bettingEndsAt,
      settlesAt: addSeconds(bettingEndsAt, game.config.revealSeconds),
      createdAt: now,
      settledAt: null,
    };
    try {
      await this.ctx.col.gameRounds.insertOne(doc);
      this.emitRound(doc);
    } catch (err) {
      // Another replica opened this round first (one_open_round_per_game / roundNo unique).
      if (!isDuplicateKeyError(err)) throw err;
    }
  }

  private async settle(round: GameRoundDoc, config: GameConfig): Promise<void> {
    const multiplier = config.payouts[round.outcome ?? ''] ?? 0;
    const now = this.ctx.clock.now();
    const winners: { userId: string; payout: number }[] = [];
    const cursor = this.ctx.col.gameBets.find({ roundId: round._id, status: 'placed' });
    for await (const bet of cursor) {
      const won = bet.option === round.outcome;
      const payout = won ? Math.floor(bet.amount * multiplier) : 0;
      await this.ctx.db.withTransaction(async (session) => {
        const res = await this.ctx.col.gameBets.updateOne(
          { _id: bet._id, status: 'placed' },
          { $set: { status: won ? 'won' : 'lost', payout, settledAt: now } },
          { session },
        );
        if (!res.modifiedCount || !payout) return;
        await this.ctx.services.wallet.credit(session, {
          uid: bet.userId,
          currency: 'diamonds',
          amount: payout,
          reason: 'game_payout',
          refId: String(bet._id),
          meta: { game: round.game, roundNo: round.roundNo },
        });
        await this.ctx.col.gameRounds.updateOne({ _id: round._id }, { $inc: { payoutTotal: payout } }, { session });
      });
      if (payout) winners.push({ userId: bet.userId, payout });
    }
    const settled = await this.ctx.col.gameRounds.findOneAndUpdate(
      { _id: round._id, status: 'locked' },
      { $set: { status: 'settled', settledAt: now } },
      { returnDocument: 'after' },
    );
    if (!settled) return;
    const byUser = new Map<string, number>();
    for (const w of winners) byUser.set(w.userId, (byUser.get(w.userId) ?? 0) + w.payout);
    for (const [uid, payout] of byUser) {
      this.ctx.realtime.toUser(SOCKET.namespaces.games, uid, SOCKET.games.settled, { roundId: String(round._id), payout });
    }
    const top = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const briefs = await this.ctx.services.users.briefs(top.map(([u]) => u));
    this.emitRound(settled, { topWinners: top.map(([u, p]) => ({ user: briefs.get(u) ?? null, payout: p })) });
  }

  /** Refund every placed bet of a stuck round (admin action). */
  async voidRound(roundId: ObjectId): Promise<{ refunded: number }> {
    const round = await this.ctx.col.gameRounds.findOne({ _id: roundId });
    if (!round) throw notFound('Round');
    if (round.status === 'settled') throw badRequest('Round already settled');
    let refunded = 0;
    const cursor = this.ctx.col.gameBets.find({ roundId, status: 'placed' });
    for await (const bet of cursor) {
      await this.ctx.db.withTransaction(async (session) => {
        const res = await this.ctx.col.gameBets.updateOne({ _id: bet._id, status: 'placed' }, { $set: { status: 'refunded', payout: bet.amount, settledAt: this.ctx.clock.now() } }, { session });
        if (!res.modifiedCount) return;
        await this.ctx.services.wallet.credit(session, { uid: bet.userId, currency: 'diamonds', amount: bet.amount, reason: 'game_refund', refId: String(bet._id) });
        refunded++;
      });
    }
    await this.ctx.col.gameRounds.updateOne({ _id: roundId }, { $set: { status: 'settled', outcome: 'void', settledAt: this.ctx.clock.now() } });
    return { refunded };
  }

  private emitRound(round: GameRoundDoc, extra: Record<string, unknown> = {}): void {
    this.ctx.realtime.toRoom(SOCKET.namespaces.games, gameRoom(round.game), SOCKET.games.round, { round: this.toRound(round), ...extra });
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  async verify(roundId: ObjectId) {
    const round = await this.ctx.col.gameRounds.findOne({ _id: roundId });
    if (!round) throw notFound('Round');
    if (round.status !== 'settled') throw badRequest('The seed is revealed after settlement');
    return {
      roundNo: round.roundNo,
      game: round.game,
      serverSeed: round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      hashMatches: hashSeed(round.serverSeed) === round.serverSeedHash,
      outcome: round.outcome,
      reveal: round.reveal,
      algorithm: 'outcome = f(HMAC-SHA256(serverSeed, "<game>:<roundNo>:<n>")), see docs/GAMES.md',
    };
  }

  async myBets(uid: string, key: GameKey | undefined, limit: number) {
    return this.ctx.col.gameBets.find({ userId: uid, ...(key ? { game: key } : {}) }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async rounds(key: GameKey, page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.ctx.col.gameRounds.find({ game: key }).sort({ roundNo: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      this.ctx.col.gameRounds.countDocuments({ game: key }),
    ]);
    return { items: items.map((r) => ({ ...this.toRound(r), betCount: r.betCount, payoutTotal: r.payoutTotal, staked: Object.values(r.totals).reduce((s, v) => s + v, 0) })), total, page, pageSize };
  }

  /** Daily staked / paid / actual RTP over the last `days` days. */
  async analytics(key: GameKey, days: number) {
    const since = addSeconds(this.ctx.clock.now(), -days * 86400);
    const rows = await this.ctx.col.gameBets
      .aggregate<{ _id: string; staked: number; paid: number; bets: number; players: string[] }>([
        { $match: { game: key, createdAt: { $gte: since }, status: { $in: ['won', 'lost'] } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            staked: { $sum: '$amount' },
            paid: { $sum: '$payout' },
            bets: { $sum: 1 },
            players: { $addToSet: '$userId' },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    const game = await this.game(key);
    const daily = rows.map((r) => ({ date: r._id, staked: r.staked, paid: r.paid, bets: r.bets, players: r.players.length, rtp: r.staked ? r.paid / r.staked : 0, houseProfit: r.staked - r.paid }));
    const staked = daily.reduce((s, d) => s + d.staked, 0);
    const paid = daily.reduce((s, d) => s + d.paid, 0);
    return { daily, totals: { staked, paid, houseProfit: staked - paid, rtp: staked ? paid / staked : 0 }, theoreticalRtp: theoreticalRtp(game.config) };
  }
}
