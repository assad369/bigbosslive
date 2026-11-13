/**
 * 2026-11 games migration: the in-house games (golden wheel, fortune ferris, teen patti) are
 * replaced by AsadSoft.
 *
 * 1. Every bet still `placed` (its round never settled) is refunded: the bet is flipped to
 *    `refunded` by a conditional update and its stake credited back with a `game_refund`
 *    ledger row, in one transaction per bet. A bet of a deleted account is voided unpaid.
 * 2. `game_rounds`, `game_bets` and the old `games` registry are dropped.
 *
 * Safe to re-run: refunds only touch bets still `placed`, and dropping a missing collection is
 * a no-op. It works on raw collections because the typed ones are gone. Running outside
 * `WalletService` is deliberate: a one-off data move, written the way the service would.
 */
import type { Database } from '../src/db/mongo.js';

export const OLD_GAME_COLLECTIONS = ['game_rounds', 'game_bets', 'games'] as const;

export interface RemoveGamesReport {
  betsRefunded: number;
  diamondsRefunded: number;
  betsVoided: number;
  dropped: string[];
}

export async function removeInhouseGames(
  db: Database,
  now: () => Date = () => new Date(),
): Promise<RemoveGamesReport> {
  const raw = db.db;
  const report: RemoveGamesReport = {
    betsRefunded: 0,
    diamondsRefunded: 0,
    betsVoided: 0,
    dropped: [],
  };
  const existing = new Set(
    (await raw.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  if (existing.has('game_bets')) {
    const bets = raw.collection('game_bets');
    const users = raw.collection('users');
    const ledger = raw.collection('ledger');
    for await (const bet of bets.find({ status: 'placed' })) {
      const amount = Number(bet.amount ?? 0);
      await db.withTransaction(async (session) => {
        const flipped = await bets.updateOne(
          { _id: bet._id, status: 'placed' },
          { $set: { status: 'refunded', settledAt: now(), payout: 0 } },
          { session },
        );
        if (!flipped.modifiedCount) return; // refunded by an earlier run
        if (!(amount > 0)) return;
        const after = await users.findOneAndUpdate(
          { _id: bet.userId, status: { $ne: 'deleted' } },
          { $inc: { 'wallet.diamonds': amount } },
          { session, returnDocument: 'after', projection: { 'wallet.diamonds': 1 } },
        );
        if (!after) {
          report.betsVoided++;
          return;
        }
        await ledger.insertOne(
          {
            userId: bet.userId,
            currency: 'diamonds',
            delta: amount,
            balanceAfter: Number(after.wallet?.diamonds ?? 0),
            reason: 'game_refund',
            refId: String(bet._id),
            createdAt: now(),
            meta: {
              game: bet.game,
              roundId: String(bet.roundId),
              migration: 'remove-inhouse-games',
            },
          },
          { session },
        );
        report.betsRefunded++;
        report.diamondsRefunded += amount;
      });
    }
  }

  for (const name of OLD_GAME_COLLECTIONS) {
    if (!existing.has(name)) continue;
    await raw.collection(name).drop();
    report.dropped.push(name);
  }
  return report;
}
