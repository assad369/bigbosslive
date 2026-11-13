import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import type { GameTxKind, LedgerReason } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { GameCounters, GameWalletTxDoc } from '../../db/schema.js';
import { AppError, isDuplicateKeyError } from '../../lib/errors.js';
import { dayKey } from '../../lib/time.js';
import { gameLock } from './access.js';

/**
 * The AsadSoft wallet callbacks: `GET /balance`, `POST /debit`, `POST /credit`
 * (FLUTTER_INTEGRATION.md §1–2 in the provider's repo, and docs/GAMES.md here).
 *
 * Money rules, each of which has cost an operator real diamonds when missing:
 * - `txId` is the idempotency: it is the `_id` of `game_wallet_txs`, claimed FIRST inside the
 *   transaction that moves the money. A retry answers exactly as the first call did.
 * - A refusal is stored under its txId too, so a retry is refused identically.
 * - `refTxId` reverses that earlier call, at most its applied amount, once. A reversal of a
 *   txId we never saw leaves a tombstone under it, and the original is refused if it arrives.
 * - A claw-back (`reverse:win:`) takes what the player still holds and records the shortfall.
 * - Credits are floored to whole diamonds; a fraction is never rounded up.
 * - New stakes are refused for a player who may not play (switch off, game off, blocked, level
 *   too low). Wins, refunds, cashback and claw-backs always go through.
 * Every movement goes through `WalletService` with a game ledger reason, which never moves
 * level. Stats are counted in the same transaction (`game_player_days`, `game_user_stats`).
 */

export type WalletCallType = 'debit' | 'credit';

export interface WalletReply {
  status: number;
  body: Record<string, unknown>;
}

const optionalStr = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).slice(0, max))
    .nullish();

export const walletTxInput = z.object({
  playerId: z.string().min(1).max(128),
  amount: z.number().finite().nonnegative(),
  txId: z.string().min(1).max(256),
  refTxId: z.string().min(1).max(256).nullish(),
  roundId: optionalStr(256),
  gameRoundId: optionalStr(128),
  sessionId: optionalStr(128),
  gameId: optionalStr(64),
  description: optionalStr(300),
  currency: optionalStr(16),
  reason: optionalStr(64),
});
export type WalletTxInput = z.infer<typeof walletTxInput>;

/** What a call is, from its txId prefix (the provider's contract table). Pure. */
export function kindOf(type: WalletCallType, txId: string, reason?: string | null): GameTxKind {
  if (type === 'credit') {
    if (reason === 'loss_cashback' || txId.startsWith('cashback:')) return 'cashback';
    if (reason === 'wager_rebate' || txId.startsWith('wager-rebate:')) return 'rebate';
    if (txId.startsWith('win:')) return 'win';
    if (txId.startsWith('refund:') || txId.startsWith('cancel:')) return 'refund';
    if (txId.startsWith('xfer-out:')) return 'transfer_out';
    return 'other_credit';
  }
  if (txId.startsWith('stake:') || txId.startsWith('bet:')) return 'stake';
  if (txId.startsWith('reverse:')) return 'reversal';
  if (txId.startsWith('xfer-in:')) return 'transfer_in';
  return 'other_debit';
}

const LEDGER_REASON: Record<GameTxKind, LedgerReason> = {
  stake: 'game_bet',
  win: 'game_payout',
  refund: 'game_refund',
  cashback: 'game_cashback',
  rebate: 'game_cashback',
  reversal: 'game_reversal',
  transfer_in: 'game_wallet_deposit',
  transfer_out: 'game_wallet_withdraw',
  other_debit: 'game_bet',
  other_credit: 'game_payout',
};

export const COUNTER_FIELDS = [
  'stakes',
  'stakeCount',
  'wins',
  'winCount',
  'cashback',
  'refunds',
  'reversals',
  'transfersIn',
  'transfersOut',
  'otherDebits',
  'otherCredits',
  'debited',
  'credited',
  'net',
] as const satisfies readonly (keyof GameCounters)[];

/**
 * The counter changes for one applied movement. A reversal (`sign` −1) nets the amount out of
 * the kind it reverses, so turnover and payouts stay net; it is also counted as a refund (of a
 * debit) or a reversal (of a credit). Pure.
 */
export function counterDelta(
  kind: GameTxKind,
  type: WalletCallType,
  amount: number,
  reversal: boolean,
): Partial<GameCounters> {
  const d: Partial<GameCounters> = {};
  const add = (k: keyof GameCounters, v: number) => {
    if (v !== 0) d[k] = (d[k] ?? 0) + v;
  };
  const sign = reversal ? -1 : 1;
  const a = amount * sign;
  switch (kind) {
    case 'stake':
      add('stakes', a);
      if (!reversal) add('stakeCount', 1);
      add('net', a);
      break;
    case 'win':
      add('wins', a);
      if (!reversal) add('winCount', 1);
      add('net', -a);
      break;
    case 'cashback':
    case 'rebate':
      add('cashback', a);
      add('net', -a);
      break;
    case 'transfer_in':
      add('transfersIn', a);
      break;
    case 'transfer_out':
      add('transfersOut', a);
      break;
    // A refund or claw-back that names no original: plain money in or out.
    case 'refund':
    case 'other_credit':
      add('otherCredits', a);
      break;
    case 'reversal':
    case 'other_debit':
      add('otherDebits', a);
      break;
  }
  if (reversal) add(type === 'credit' ? 'refunds' : 'reversals', amount);
  add(type === 'debit' ? 'debited' : 'credited', amount);
  return d;
}

/** Whole diamonds, never rounded up (`202.5` pays 202). */
const floorUnits = (n: number) => Math.floor(n + 1e-9);

class Refusal extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class GameWalletService {
  constructor(private readonly ctx: Ctx) {}

  async balance(playerId: string): Promise<WalletReply> {
    const user = await this.ctx.col.users.findOne(
      { _id: playerId, status: { $ne: 'deleted' } },
      { projection: { wallet: 1 } },
    );
    if (!user) return { status: 404, body: { success: false, error: 'PLAYER_NOT_FOUND' } };
    const balance = user.wallet.diamonds;
    return {
      status: 200,
      body: { success: true, balance, data: { playerId, balance, currency: 'DIAMOND' } },
    };
  }

  /** Apply one signed `/debit` or `/credit`. Never throws for a refusal; infra errors throw (500). */
  async apply(type: WalletCallType, raw: unknown): Promise<WalletReply> {
    const parsed = walletTxInput.safeParse(raw);
    if (!parsed.success) return reply400('Malformed request');
    const body = parsed.data;
    const refTxId = body.refTxId ?? null;
    // Stakes must be whole diamonds; anything paid out (or clawed back) is floored.
    const amount = type === 'debit' && !refTxId ? body.amount : floorUnits(body.amount);
    if (!Number.isSafeInteger(amount) || (type === 'debit' && !refTxId && amount <= 0))
      return reply400('Amount must be a positive whole number of diamonds');

    const seen = await this.ctx.col.gameWalletTxs.findOne({ _id: body.txId });
    if (seen) return this.reply(seen, body);

    const kind = kindOf(type, body.txId, body.reason);
    const now = this.ctx.clock.now();
    const base: GameWalletTxDoc = {
      _id: body.txId,
      type,
      kind,
      status: 'applied',
      uid: body.playerId,
      gameId: body.gameId ?? null,
      roundId: body.roundId ?? null,
      gameRoundId: body.gameRoundId ?? null,
      sessionId: body.sessionId ?? null,
      refTxId,
      requested: body.amount,
      applied: amount,
      shortfall: 0,
      balanceAfter: null,
      code: null,
      httpStatus: 200,
      description: body.description ?? null,
      currency: body.currency ?? null,
      statsDay: dayKey(now, this.ctx.env.GAMES_REPORT_TIMEZONE),
      createdAt: now,
    };

    try {
      if (type === 'debit' && !refTxId) await this.assertMayStake(base);
      const row = await this.ctx.db.withTransaction((session) => this.move(session, base));
      return this.reply(row, body);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // An identical call won the race (or this txId was tombstoned meanwhile).
        const stored = await this.ctx.col.gameWalletTxs.findOne({ _id: body.txId });
        if (stored) return this.reply(stored, body);
        throw err;
      }
      const refusal = refusalOf(err);
      if (!refusal) throw err;
      // The transaction rolled back. Remember the refusal so a retry is refused the same way.
      const stored = await this.remember({
        ...base,
        status: 'rejected',
        applied: 0,
        code: refusal.code,
        httpStatus: refusal.httpStatus,
      });
      return this.reply(stored, body);
    }
  }

  /** The stake gate: the same rule as launch (`gameLock`), minus the live-room check. */
  private async assertMayStake(row: GameWalletTxDoc): Promise<void> {
    const [settings, user, game] = await Promise.all([
      this.ctx.services.games.settings(),
      this.ctx.col.users.findOne(
        { _id: row.uid },
        { projection: { level: 1, status: 1, gamesBlock: 1 } },
      ),
      row.gameId && row.kind !== 'transfer_in'
        ? this.ctx.col.gameCatalog.findOne({ _id: row.gameId })
        : Promise.resolve(undefined),
    ]);
    if (!user || user.status === 'deleted') throw new Refusal(404, 'PLAYER_NOT_FOUND');
    const lock = gameLock({ settings, user, game: game ?? (row.gameId ? null : undefined) });
    if (!lock) return;
    if (lock.reason === 'blocked')
      throw new Refusal(403, user.status === 'active' ? 'PLAYER_BLOCKED' : 'PLAYER_INACTIVE');
    if (lock.reason === 'level') throw new Refusal(403, 'LEVEL_TOO_LOW');
    throw new Refusal(403, settings.enabled ? 'GAME_DISABLED' : 'GAMES_DISABLED');
  }

  /** Claim the txId, resolve a reversal, move the diamonds and count it. Inside the transaction. */
  private async move(session: ClientSession, base: GameWalletTxDoc): Promise<GameWalletTxDoc> {
    const { col } = this.ctx;
    const row: GameWalletTxDoc = { ...base };
    // Claim first: a concurrent duplicate fails right here.
    await col.gameWalletTxs.insertOne(row, { session });

    let statsKind = row.kind;
    let statsDay = row.statsDay;
    let reversal = false;
    if (row.refTxId) {
      const original = await col.gameWalletTxs.findOne({ _id: row.refTxId }, { session });
      if (!original) {
        // Never arrived. A tombstone under ITS id makes a late arrival collide and be refused.
        const otherType: WalletCallType = row.type === 'debit' ? 'credit' : 'debit';
        await col.gameWalletTxs.insertOne(
          {
            ...base,
            _id: row.refTxId,
            type: otherType,
            kind: kindOf(otherType, row.refTxId),
            status: 'tombstone',
            refTxId: null,
            reversedBy: row._id,
            requested: 0,
            applied: 0,
            code: 'TX_VOIDED',
            httpStatus: 409,
            description: null,
            statsDay: null,
          },
          { session },
        );
        row.applied = 0;
      } else if (
        original.status !== 'applied' ||
        original.uid !== row.uid ||
        original.type === row.type
      ) {
        row.applied = 0; // already reversed, refused, a tombstone, or not reversible by this
      } else {
        row.applied = Math.min(row.applied, original.applied);
        await col.gameWalletTxs.updateOne(
          { _id: original._id, status: 'applied' },
          { $set: { status: 'reversed', reversedBy: row._id } },
          { session },
        );
        // Count it against what it reverses, on that day and game.
        statsKind = original.kind;
        statsDay = original.statsDay ?? statsDay;
        row.gameId = row.gameId ?? original.gameId;
        reversal = true;
      }
    }

    const holder = await col.users.findOne(
      { _id: row.uid, status: { $ne: 'deleted' } },
      { session, projection: { wallet: 1 } },
    );
    if (!holder) throw new Refusal(404, 'PLAYER_NOT_FOUND');
    if (row.type === 'debit' && row.refTxId && row.applied > 0) {
      // A claw-back takes what is left. Refusing it whenever the win was already spent would
      // let the player keep all of it.
      row.shortfall = Math.max(0, row.applied - holder.wallet.diamonds);
      row.applied -= row.shortfall;
    }

    let balance = holder.wallet.diamonds;
    if (row.applied > 0) {
      const movement = {
        uid: row.uid,
        currency: 'diamonds' as const,
        amount: row.applied,
        reason: LEDGER_REASON[row.kind],
        refId: row._id,
        meta: {
          provider: 'asadsoft',
          kind: row.kind,
          gameId: row.gameId,
          roundId: row.roundId,
          ...(row.refTxId ? { refTxId: row.refTxId } : {}),
        },
      };
      balance =
        row.type === 'debit'
          ? await this.ctx.services.wallet.debit(session, movement)
          : await this.ctx.services.wallet.credit(session, movement);
      await this.count(session, row, statsKind, statsDay, reversal);
    }
    row.balanceAfter = balance;
    await col.gameWalletTxs.updateOne(
      { _id: row._id },
      {
        $set: {
          applied: row.applied,
          shortfall: row.shortfall,
          balanceAfter: balance,
          gameId: row.gameId,
        },
      },
      { session },
    );
    return row;
  }

  private async count(
    session: ClientSession,
    row: GameWalletTxDoc,
    kind: GameTxKind,
    day: string | null,
    reversal: boolean,
  ): Promise<void> {
    const delta = counterDelta(kind, row.type, row.applied, reversal);
    if (Object.keys(delta).length === 0 || !day) return;
    const now = this.ctx.clock.now();
    const gameId = row.gameId ?? '_none';
    await this.ctx.col.gamePlayerDays.updateOne(
      { _id: `${day}:${row.uid}:${gameId}` },
      {
        $inc: delta,
        $set: { updatedAt: now },
        $setOnInsert: { day, uid: row.uid, gameId },
      },
      { session, upsert: true },
    );
    await this.ctx.col.gameUserStats.updateOne(
      { _id: row.uid },
      {
        $inc: delta,
        $set: { lastPlayedAt: now, ...(row.gameId ? { lastGameId: row.gameId } : {}) },
        $setOnInsert: { firstPlayedAt: now, ...(row.gameId ? {} : { lastGameId: null }) },
      },
      { session, upsert: true },
    );
  }

  private async remember(row: GameWalletTxDoc): Promise<GameWalletTxDoc> {
    try {
      await this.ctx.col.gameWalletTxs.insertOne(row);
      return row;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const stored = await this.ctx.col.gameWalletTxs.findOne({ _id: row._id });
      if (!stored) throw err;
      return stored;
    }
  }

  private reply(row: GameWalletTxDoc, body: WalletTxInput): WalletReply {
    if (row.status === 'tombstone')
      return { status: 409, body: { success: false, error: 'TX_VOIDED' } };
    if (row.status === 'rejected')
      return { status: row.httpStatus, body: { success: false, error: row.code } };
    // A replay of another player's txId must not echo their balance.
    const balance = row.uid === body.playerId ? row.balanceAfter : null;
    return {
      status: 200,
      body: {
        success: true,
        balance,
        data: {
          playerId: row.uid,
          balance,
          [row.type === 'debit' ? 'deducted' : 'credited']: row.applied,
          roundId: row.roundId,
        },
      },
    };
  }
}

const reply400 = (error: string): WalletReply => ({
  status: 400,
  body: { success: false, error },
});

/** A refusal to remember under the txId, or null for an infrastructure error. */
function refusalOf(err: unknown): Refusal | null {
  if (err instanceof Refusal) return err;
  if (err instanceof AppError) {
    if (err.code === 'insufficient_balance') return new Refusal(402, 'INSUFFICIENT_BALANCE');
    if (err.code === 'not_found') return new Refusal(404, 'PLAYER_NOT_FOUND');
    if (err.code === 'forbidden') return new Refusal(403, 'PLAYER_INACTIVE');
  }
  return null;
}
