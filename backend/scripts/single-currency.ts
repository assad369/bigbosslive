/**
 * 2026-11 single-currency migration: beans are gone, diamonds are the only user currency.
 *
 * - Every bean balance is added to the user's diamonds 1:1 (beans were always credited in
 *   diamond units) with a `currency_merge` ledger row, in one transaction per user.
 * - Historical bean ledger rows are relabelled `diamonds` and tagged `meta.legacyCurrency`.
 * - Stored `*beans` fields are renamed to `*diamonds`, and the indexes on the old names dropped.
 *
 * Safe to re-run: every step only touches documents that still have an old field. It works on
 * raw collections because the typed ones no longer know the old field names. Running outside
 * `WalletService` is deliberate: this is a one-off data move, written the way the service would.
 */
import type { Document } from 'mongodb';
import type { Database } from '../src/db/mongo.js';

const RENAMES: { collection: string; fields: Record<string, string> }[] = [
  { collection: 'live_rooms', fields: { giftBeans: 'giftDiamonds' } },
  {
    collection: 'agencies',
    fields: { 'period.beans': 'period.diamonds', 'lifetime.beans': 'lifetime.diamonds' },
  },
  {
    collection: 'agency_members',
    fields: { periodBeans: 'periodDiamonds', lifetimeBeans: 'lifetimeDiamonds' },
  },
  { collection: 'agency_periods', fields: { beans: 'diamonds' } },
  { collection: 'agency_daily_stats', fields: { beans: 'diamonds' } },
  { collection: 'withdrawals', fields: { beans: 'diamonds' } },
  {
    collection: 'app_config',
    fields: {
      'value.beansPerUsd': 'value.diamondsPerUsd',
      'value.minWithdrawBeans': 'value.minWithdrawDiamonds',
    },
  },
];

/** Indexes keyed on a field that no longer exists. */
const STALE_INDEXES: { collection: string; field: string }[] = [
  { collection: 'agencies', field: 'period.beans' },
  { collection: 'agency_members', field: 'periodBeans' },
];

export interface SingleCurrencyReport {
  usersMerged: number;
  diamondsMerged: number;
  ledgerRelabelled: number;
  renamed: Record<string, number>;
  giftTransactions: number;
  indexesDropped: string[];
}

export async function migrateToSingleCurrency(
  db: Database,
  now: () => Date = () => new Date(),
): Promise<SingleCurrencyReport> {
  const raw = db.db;
  const report: SingleCurrencyReport = {
    usersMerged: 0,
    diamondsMerged: 0,
    ledgerRelabelled: 0,
    renamed: {},
    giftTransactions: 0,
    indexesDropped: [],
  };

  // Historical rows first, so the merge rows written below are not relabelled.
  const relabel = await raw
    .collection('ledger')
    .updateMany(
      { currency: 'beans' },
      { $set: { currency: 'diamonds', 'meta.legacyCurrency': 'beans' } },
    );
  report.ledgerRelabelled = relabel.modifiedCount;

  const users = raw.collection('users');
  const ledger = raw.collection('ledger');
  const pending = users.find(
    { 'wallet.beans': { $exists: true } },
    { projection: { _id: 1, 'wallet.beans': 1 } },
  );
  for await (const u of pending) {
    const beans = Number((u.wallet as Document | undefined)?.beans ?? 0);
    await db.withTransaction(async (session) => {
      // Conditional on the value read, so a concurrent change makes this a no-op, not a double.
      const after = await users.findOneAndUpdate(
        { _id: u._id, 'wallet.beans': u.wallet.beans },
        {
          $inc: { 'wallet.diamonds': beans > 0 ? beans : 0 },
          $unset: { 'wallet.beans': '' },
        },
        { session, returnDocument: 'after', projection: { 'wallet.diamonds': 1 } },
      );
      if (!after || beans <= 0) return;
      await ledger.insertOne(
        {
          userId: u._id,
          currency: 'diamonds',
          delta: beans,
          balanceAfter: Number((after.wallet as Document).diamonds),
          reason: 'currency_merge',
          refId: null,
          createdAt: now(),
          meta: { from: 'beans' },
        },
        { session },
      );
      report.usersMerged++;
      report.diamondsMerged += beans;
    });
  }

  for (const { collection, fields } of RENAMES) {
    const res = await raw
      .collection(collection)
      .updateMany(
        { $or: Object.keys(fields).map((f) => ({ [f]: { $exists: true } })) },
        { $rename: fields },
      );
    report.renamed[collection] = res.modifiedCount;
  }

  // receivers[].beans → receivers[].diamonds ($rename can't reach into arrays).
  const gifts = await raw
    .collection('gift_transactions')
    .updateMany({ 'receivers.beans': { $exists: true } }, [
      {
        $set: {
          receivers: {
            $map: {
              input: '$receivers',
              as: 'r',
              in: {
                $mergeObjects: [
                  {
                    $arrayToObject: {
                      $filter: {
                        input: { $objectToArray: '$$r' },
                        cond: { $ne: ['$$this.k', 'beans'] },
                      },
                    },
                  },
                  // A missing `beans` (already migrated) evaluates to missing and is skipped.
                  { diamonds: '$$r.beans' },
                ],
              },
            },
          },
        },
      },
    ]);
  report.giftTransactions = gifts.modifiedCount;

  for (const { collection, field } of STALE_INDEXES) {
    const indexes = await raw
      .collection(collection)
      .listIndexes()
      .toArray()
      .catch(() => [] as Document[]);
    for (const ix of indexes) {
      if (!Object.prototype.hasOwnProperty.call(ix.key ?? {}, field)) continue;
      await raw.collection(collection).dropIndex(String(ix.name));
      report.indexesDropped.push(`${collection}.${String(ix.name)}`);
    }
  }
  return report;
}
