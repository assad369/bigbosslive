/**
 * Report every past recharge to AsadSoft (`POST /purchases`), so its dashboard can show hold
 * against what players actually bought. New recharges are reported by the `games.purchase` job;
 * this is for the history before that. Idempotent on AsadSoft's side (purchaseId = recharge id),
 * so re-running it records nothing twice.
 *   npm run games:backfill-purchases [-- --since 2026-01-01]
 */
import type { Filter } from 'mongodb';
import { loadEnv } from '../src/config/env.js';
import type { RechargeDoc } from '../src/db/schema.js';
import { createAsadSoftGateway } from '../src/infra/asadsoft.js';
import { withDb } from './_db.js';

const BATCH = 500;
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? new Date(process.argv[sinceArg + 1] ?? '') : null;
if (since && Number.isNaN(since.getTime()))
  throw new Error('--since takes a date, e.g. 2026-01-01');

const gateway = createAsadSoftGateway(loadEnv());
if (!gateway.configured) throw new Error('ASADSOFT_API_URL and ASADSOFT_API_KEY are required');

await withDb(async (db) => {
  const q: Filter<RechargeDoc> = since ? { createdAt: { $gte: since } } : {};
  let sent = 0;
  let recorded = 0;
  let duplicates = 0;
  let batch: RechargeDoc[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await gateway.reportPurchases(
      batch.map((x) => ({
        purchaseId: String(x._id),
        playerId: x.userId,
        diamonds: x.diamonds,
        purchasedAt: x.createdAt,
        source: x.source,
      })),
    );
    sent += batch.length;
    recorded += r.recorded;
    duplicates += r.duplicates;
    console.log(`  sent ${sent} (recorded ${recorded}, duplicates ${duplicates})`);
    batch = [];
  };
  for await (const r of db.col.recharges.find(q).sort({ createdAt: 1, _id: 1 })) {
    if (!(r.diamonds > 0)) continue;
    batch.push(r);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  console.log(`done: ${sent} recharge(s) reported`);
});
