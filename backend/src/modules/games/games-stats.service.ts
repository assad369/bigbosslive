import type { Document, Filter } from 'mongodb';
import { z } from 'zod';
import {
  GAME_ID_PATTERN,
  GAME_TX_KINDS,
  GAME_TX_STATUSES,
  type GameMoney,
  type GamePlayerSummary,
  type GameStatsByGame,
  type GameStatsDay,
  type GameStatsOverview,
  type GameStatsPeriod,
  type GameTopPlayer,
  type GameTransaction,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { GameCounters, GameWalletTxDoc } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';
import { dayKey } from '../../lib/time.js';
import { COUNTER_FIELDS } from './game-wallet.service.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range a daily/per-game/top-players report covers. */
const MAX_RANGE_DAYS = 366;
const CACHE_MS = 30_000;

export const dayRangeQuery = z.object({
  from: z.string().regex(DAY, 'YYYY-MM-DD'),
  to: z.string().regex(DAY, 'YYYY-MM-DD'),
});

export const transactionsQuery = z.object({
  /** A uid or short id. */
  user: z.string().trim().min(1).max(128).optional(),
  gameId: z.string().regex(GAME_ID_PATTERN).optional(),
  kind: z.enum(GAME_TX_KINDS).optional(),
  status: z.enum(GAME_TX_STATUSES).optional(),
  roundId: z.string().trim().min(1).max(256).optional(),
  txId: z.string().trim().min(1).max(256).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(800).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Calendar arithmetic on "YYYY-MM-DD" keys. Pure. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

type Counters = Record<(typeof COUNTER_FIELDS)[number], number>;

const sumCounters = Object.fromEntries(COUNTER_FIELDS.map((f) => [f, { $sum: `$${f}` }]));

/** Money figures from summed counters. Pure. */
export function moneyOf(c: Partial<GameCounters> | null | undefined): GameMoney {
  const v = (k: keyof GameCounters) => Number(c?.[k] ?? 0);
  const turnover = v('stakes');
  const payouts = v('wins');
  const cashback = v('cashback');
  return {
    turnover,
    payouts,
    cashback,
    ggr: turnover - payouts - cashback,
    rtp: turnover > 0 ? (payouts + cashback) / turnover : null,
    stakeCount: v('stakeCount'),
    winCount: v('winCount'),
    refunds: v('refunds'),
    reversals: v('reversals'),
    transfersIn: v('transfersIn'),
    transfersOut: v('transfersOut'),
    netFlow: v('debited') - v('credited'),
  };
}

/**
 * Games reports for the admin, read from the per-player daily rows and lifetime rows that the
 * wallet writes in the same transaction as each movement, so they always reconcile to it.
 * Days are calendar days in `GAMES_REPORT_TIMEZONE`. GGR is the platform's win (positive) or
 * loss (negative): turnover − payouts − cashback.
 */
export class GamesStatsService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly ctx: Ctx) {}

  private get tz() {
    return this.ctx.env.GAMES_REPORT_TIMEZONE;
  }

  private today(): string {
    return dayKey(this.ctx.clock.now(), this.tz);
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private checkRange(from: string, to: string) {
    const span = daysBetween(from, to);
    if (span < 0) throw badRequest('`from` must not be after `to`');
    if (span >= MAX_RANGE_DAYS) throw badRequest(`At most ${MAX_RANGE_DAYS} days`);
  }

  /** Totals and distinct players over [from, to] (inclusive day keys). */
  async period(from: string, to: string, gameId?: string): Promise<GameStatsPeriod> {
    this.checkRange(from, to);
    const match: Document = { day: { $gte: from, $lte: to } };
    if (gameId) match.gameId = gameId;
    const [row] = await this.ctx.col.gamePlayerDays
      .aggregate<Counters & { players: number }>(
        [
          { $match: match },
          { $group: { _id: '$uid', ...sumCounters } },
          { $group: { _id: null, players: { $sum: 1 }, ...sumCounters } },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    return { from, to, players: row?.players ?? 0, ...moneyOf(row) };
  }

  async overview(range?: { from: string; to: string }): Promise<GameStatsOverview> {
    const today = this.today();
    const yesterday = shiftDay(today, -1);
    const base = await this.cached(`overview:${today}`, async () => {
      const [t, y, w, m, [all]] = await Promise.all([
        this.period(today, today),
        this.period(yesterday, yesterday),
        this.period(shiftDay(today, -6), today),
        this.period(shiftDay(today, -29), today),
        this.ctx.col.gameUserStats
          .aggregate<Counters>([{ $group: { _id: null, ...sumCounters } }])
          .toArray(),
      ]);
      return { today: t, yesterday: y, last7Days: w, last30Days: m, allTime: moneyOf(all) };
    });
    return {
      timezone: this.tz,
      ...base,
      range: range ? await this.period(range.from, range.to) : null,
    };
  }

  /** One row per day in [from, to], zero-filled. */
  async daily(from: string, to: string): Promise<GameStatsDay[]> {
    this.checkRange(from, to);
    return this.cached(`daily:${from}:${to}:${this.today()}`, async () => {
      const rows = await this.ctx.col.gamePlayerDays
        .aggregate<Counters & { _id: string; players: number }>(
          [
            { $match: { day: { $gte: from, $lte: to } } },
            { $group: { _id: { day: '$day', uid: '$uid' }, ...sumCounters } },
            { $group: { _id: '$_id.day', players: { $sum: 1 }, ...sumCounters } },
          ],
          { allowDiskUse: true },
        )
        .toArray();
      const byDay = new Map(rows.map((r) => [r._id, r]));
      const out: GameStatsDay[] = [];
      for (let d = from; d <= to; d = shiftDay(d, 1)) {
        const r = byDay.get(d);
        out.push({ day: d, players: r?.players ?? 0, ...moneyOf(r) });
      }
      return out;
    });
  }

  async byGame(from: string, to: string): Promise<(GameStatsByGame & { players: number })[]> {
    this.checkRange(from, to);
    const rows = await this.ctx.col.gamePlayerDays
      .aggregate<Counters & { _id: string; players: number }>(
        [
          { $match: { day: { $gte: from, $lte: to } } },
          { $group: { _id: { gameId: '$gameId', uid: '$uid' }, ...sumCounters } },
          { $group: { _id: '$_id.gameId', players: { $sum: 1 }, ...sumCounters } },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    const games = await this.ctx.col.gameCatalog
      .find(
        { _id: { $in: rows.map((r) => r._id) } },
        { projection: { provider: 1, displayName: 1 } },
      )
      .toArray();
    const names = new Map(games.map((g) => [g._id, g.displayName ?? g.provider.name]));
    return rows
      .map((r) => ({
        gameId: r._id,
        name: r._id === '_none' ? 'Game wallet transfers' : (names.get(r._id) ?? r._id),
        players: r.players,
        ...moneyOf(r),
      }))
      .sort((a, b) => b.turnover - a.turnover || a.gameId.localeCompare(b.gameId));
  }

  /** Biggest winners (players up the most) or losers over [from, to]. */
  async topPlayers(
    from: string,
    to: string,
    side: 'winners' | 'losers',
    limit = 20,
  ): Promise<GameTopPlayer[]> {
    this.checkRange(from, to);
    const rows = await this.ctx.col.gamePlayerDays
      .aggregate<Counters & { _id: string }>(
        [
          { $match: { day: { $gte: from, $lte: to } } },
          { $group: { _id: '$uid', ...sumCounters } },
          { $match: { net: side === 'winners' ? { $lt: 0 } : { $gt: 0 } } },
          { $sort: { net: side === 'winners' ? 1 : -1, _id: 1 } },
          { $limit: limit },
        ],
        { allowDiskUse: true },
      )
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r._id));
    return rows.map((r) => {
      const m = moneyOf(r);
      return {
        uid: r._id,
        user: briefs.get(r._id) ?? null,
        playerNet: -m.ggr,
        turnover: m.turnover,
        payouts: m.payouts,
        cashback: m.cashback,
      };
    });
  }

  async transactions(input: z.infer<typeof transactionsQuery>) {
    const q: Filter<GameWalletTxDoc> = {};
    if (input.user) q.uid = (await this.ctx.services.users.resolve(input.user))._id;
    if (input.gameId) q.gameId = input.gameId;
    if (input.kind) q.kind = input.kind;
    if (input.status) q.status = input.status;
    if (input.roundId) q.roundId = input.roundId;
    if (input.txId) q._id = input.txId;
    if (input.from || input.to)
      q.createdAt = {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lt: input.to } : {}),
      };
    Object.assign(q, afterCursor(input.cursor, 'createdAt', true));
    const rows = await this.ctx.col.gameWalletTxs
      .find(q)
      .sort({ createdAt: -1, _id: -1 })
      .limit(input.limit + 1)
      .toArray();
    const page = rows.slice(0, input.limit);
    const briefs = await this.ctx.services.users.briefs([...new Set(page.map((r) => r.uid))]);
    const last = page.at(-1);
    return {
      items: page.map((r) => toTransaction(r, briefs.get(r.uid) ?? null)),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last._id) : null,
    };
  }

  async player(identifier: string): Promise<GamePlayerSummary> {
    const user = await this.ctx.services.users.resolve(identifier);
    const today = this.today();
    const [life, todayRows, briefs] = await Promise.all([
      this.ctx.col.gameUserStats.findOne({ _id: user._id }),
      this.ctx.col.gamePlayerDays.find({ uid: user._id, day: today }).toArray(),
      this.ctx.services.users.briefs([user._id]),
    ]);
    const todaySum: Partial<GameCounters> = {};
    for (const row of todayRows)
      for (const f of COUNTER_FIELDS) todaySum[f] = (todaySum[f] ?? 0) + Number(row[f] ?? 0);
    const lifeMoney = moneyOf(life);
    const todayMoney = moneyOf(todaySum);
    return {
      uid: user._id,
      user: briefs.get(user._id) ?? null,
      block: user.gamesBlock
        ? {
            at: user.gamesBlock.at.toISOString(),
            by: user.gamesBlock.by,
            reason: user.gamesBlock.reason,
          }
        : null,
      lifetime: {
        ...lifeMoney,
        playerNet: -lifeMoney.ggr,
        firstPlayedAt: life?.firstPlayedAt?.toISOString() ?? null,
        lastPlayedAt: life?.lastPlayedAt?.toISOString() ?? null,
        lastGameId: life?.lastGameId ?? null,
      },
      today: { ...todayMoney, playerNet: -todayMoney.ggr },
    };
  }
}

export function toTransaction(r: GameWalletTxDoc, user: GameTransaction['user']): GameTransaction {
  return {
    txId: r._id,
    type: r.type,
    kind: r.kind,
    status: r.status,
    uid: r.uid,
    user,
    gameId: r.gameId,
    roundId: r.roundId,
    gameRoundId: r.gameRoundId,
    sessionId: r.sessionId,
    refTxId: r.refTxId,
    reversedBy: r.reversedBy ?? null,
    requested: r.requested,
    applied: r.applied,
    shortfall: r.shortfall,
    balanceAfter: r.balanceAfter,
    code: r.code,
    httpStatus: r.httpStatus,
    description: r.description,
    currency: r.currency,
    createdAt: r.createdAt.toISOString(),
  };
}
