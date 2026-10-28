/**
 * Versioned data migrations. Each runs once, in order, and is recorded in `migrations`.
 * Indexes are (re)ensured first. Usage: npm run migrate [-- --dry-run]
 */
import { loadEnv } from '../src/config/env.js';
import type { Database } from '../src/db/mongo.js';
import { monthKey } from '../src/lib/time.js';
import { newAgencyCode } from '../src/modules/agencies/agencies.service.js';
import { withDb } from './_db.js';

interface Migration {
  id: string;
  up(db: Database): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: '2026-01-01-initial',
    async up() {
      // Baseline: the schema is created by ensureIndexes(). Kept as the first entry so later
      // migrations have a known starting point.
    },
  },
  {
    id: '2026-10-27-agency-dashboard',
    async up(db) {
      const periodKey = monthKey(new Date(), loadEnv().AGENCY_RESET_TIMEZONE);
      // Members: roles, locks, targets and lifetime counters (lifetime starts at this month).
      await db.col.agencyMembers.updateMany({ role: { $exists: false } }, [
        {
          $set: {
            role: 'host',
            locked: false,
            dailyTargetMinutes: null,
            lifetimeBeans: { $cond: [{ $eq: ['$periodKey', periodKey] }, '$periodBeans', 0] },
            lifetimeLiveSeconds: {
              $cond: [{ $eq: ['$periodKey', periodKey] }, '$periodLiveSeconds', 0],
            },
          },
        },
      ]);
      for await (const agency of db.col.agencies.find({ code: { $exists: false } })) {
        // Agency-wide counters, rebuilt from the members' current month and the gift history.
        const [month] = await db.col.agencyMembers
          .aggregate<{ beans: number; live: number }>([
            { $match: { agencyId: agency._id, periodKey } },
            {
              $group: {
                _id: null,
                beans: { $sum: '$periodBeans' },
                live: { $sum: '$periodLiveSeconds' },
              },
            },
          ])
          .toArray();
        const [gifts] = await db.col.giftTransactions
          .aggregate<{ beans: number; commission: number; gifts: number }>([
            { $match: { 'receivers.agencyId': agency._id } },
            { $unwind: '$receivers' },
            { $match: { 'receivers.agencyId': agency._id } },
            {
              $group: {
                _id: null,
                beans: { $sum: '$receivers.beans' },
                commission: { $sum: '$receivers.agencyFee' },
                gifts: { $sum: '$quantity' },
              },
            },
          ])
          .toArray();
        const [past] = await db.col.agencyPeriods
          .aggregate<{ live: number }>([
            { $match: { agencyId: agency._id } },
            { $group: { _id: null, live: { $sum: '$liveSeconds' } } },
          ])
          .toArray();
        for (let attempt = 0; ; attempt++) {
          try {
            await db.col.agencies.updateOne(
              { _id: agency._id },
              {
                $set: {
                  code: newAgencyCode(),
                  period: {
                    key: periodKey,
                    beans: month?.beans ?? 0,
                    liveSeconds: month?.live ?? 0,
                    commission: 0,
                    gifts: 0,
                  },
                  lifetime: {
                    beans: gifts?.beans ?? 0,
                    liveSeconds: (past?.live ?? 0) + (month?.live ?? 0),
                    commission: gifts?.commission ?? 0,
                    gifts: gifts?.gifts ?? 0,
                  },
                },
              },
            );
            break;
          } catch (err) {
            if (attempt >= 4) throw err; // code collision: draw another
          }
        }
      }
    },
  },
  {
    id: '2026-10-27-vip-ladder',
    async up(db) {
      // The ladder is VIP / VVIP / King. Rename only packages still on their seeded names.
      const renames: [number, string, string][] = [
        [1, 'Gold VIP', 'VIP'],
        [2, 'Platinum VIP', 'VVIP'],
        [3, 'Royal VIP', 'King'],
      ];
      for (const [tier, from, to] of renames)
        await db.col.vipPackages.updateOne({ tier, name: from }, { $set: { name: to } });
      await db.col.vipPackages.updateMany({ tier: { $gt: 3 } }, { $set: { active: false } });
      // Packages: frame format from the file extension, and no entrance effect yet.
      for await (const pkg of db.col.vipPackages.find({ frameFormat: { $exists: false } })) {
        await db.col.vipPackages.updateOne(
          { _id: pkg._id },
          {
            $set: {
              frameFormat: pkg.frameUrl && /\.svga(\?|$)/i.test(pkg.frameUrl) ? 'svga' : 'none',
              entryAnimationUrl: null,
              entryAnimationFormat: 'none',
            },
          },
        );
      }
      // Users: format of an equipped store frame, and their tier's frame.
      for await (const item of db.col.cosmetics.find({ type: 'frame' })) {
        await db.col.users.updateMany(
          { 'equipped.frameId': item._id },
          { $set: { 'equipped.frameFormat': item.animationFormat } },
        );
      }
      await db.col.users.updateMany(
        { 'equipped.frameFormat': { $exists: false } },
        { $set: { 'equipped.frameFormat': 'none' } },
      );
      for await (const pkg of db.col.vipPackages.find()) {
        await db.col.users.updateMany(
          { 'vip.tier': pkg.tier },
          {
            $set: {
              'equipped.vipFrameUrl': pkg.frameUrl,
              'equipped.vipFrameFormat': pkg.frameUrl ? (pkg.frameFormat ?? 'none') : 'none',
            },
          },
        );
      }
    },
  },
];

const dryRun = process.argv.includes('--dry-run');

await withDb(async (db) => {
  const applied = new Set((await db.col.migrations.find().toArray()).map((m) => m._id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    console.log(`${dryRun ? '[dry-run] would apply' : 'applying'} ${m.id}`);
    if (dryRun) continue;
    await m.up(db);
    await db.col.migrations.insertOne({ _id: m.id, appliedAt: new Date() });
  }
  console.log('migrations up to date');
});
