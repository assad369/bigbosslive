/**
 * Versioned data migrations. Each runs once, in order, and is recorded in `migrations`.
 * Indexes are (re)ensured first. Usage: npm run migrate [-- --dry-run]
 */
import { loadEnv } from '../src/config/env.js';
import type { Database } from '../src/db/mongo.js';
import { monthKey } from '../src/lib/time.js';
import { newAgencyCode } from '../src/modules/agencies/agencies.service.js';
import { withDb } from './_db.js';
import { lockAgencyMembers } from './lock-agency-members.js';
import { removeInhouseGames } from './remove-inhouse-games.js';
import { migrateToSingleCurrency } from './single-currency.js';

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
            // Raw collection: this migration predates the beans → diamonds rename.
            await db.db.collection('agencies').updateOne(
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
      // `vip_packages` was retired by 2026-11-10-tier-packages; reached through a raw handle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vipPackages = db.db.collection<any>('vip_packages');
      // The ladder is VIP / VVIP / King. Rename only packages still on their seeded names.
      const renames: [number, string, string][] = [
        [1, 'Gold VIP', 'VIP'],
        [2, 'Platinum VIP', 'VVIP'],
        [3, 'Royal VIP', 'King'],
      ];
      for (const [tier, from, to] of renames)
        await vipPackages.updateOne({ tier, name: from }, { $set: { name: to } });
      await vipPackages.updateMany({ tier: { $gt: 3 } }, { $set: { active: false } });
      // Packages: frame format from the file extension, and no entrance effect yet.
      for await (const pkg of vipPackages.find({ frameFormat: { $exists: false } })) {
        await vipPackages.updateOne(
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
      for await (const pkg of vipPackages.find()) {
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
  {
    id: '2026-11-01-single-currency',
    async up(db) {
      // Beans are folded into diamonds and every stored bean field is renamed.
      console.log(JSON.stringify(await migrateToSingleCurrency(db)));
    },
  },
  {
    id: '2026-11-10-tier-packages',
    async up(db) {
      // VIP becomes tier packages (VIP / VVIP / Crown / King), sold as badge artwork. Old
      // memberships are not carried over: the old packages and every worn tier are dropped.
      await db.db
        .collection('vip_packages')
        .drop()
        .catch(() => undefined);
      await db.col.users.updateMany(
        {},
        {
          $set: { vip: { tier: 0, expiresAt: null, packageId: null, badge: null } },
          $unset: { 'equipped.vipFrameUrl': '', 'equipped.vipFrameFormat': '' },
        },
      );
      await db.col.liveRooms.updateMany({ hostVipTier: { $gt: 0 } }, { $set: { hostVipTier: 0 } });
      // King moves from tier 3 to 4 (Crown is the new 3): whatever needed King still does.
      await db.col.gifts.updateMany({ vipTierRequired: 3 }, { $set: { vipTierRequired: 4 } });
      await db.col.cosmetics.updateMany({ vipTierRequired: 3 }, { $set: { vipTierRequired: 4 } });
      await db.col.users.updateMany(
        { 'equipped.frameVipTier': 3 },
        { $set: { 'equipped.frameVipTier': 4 } },
      );
      await db.col.users.updateMany(
        { 'equipped.entryAnimationVipTier': 3 },
        { $set: { 'equipped.entryAnimationVipTier': 4 } },
      );
    },
  },
  {
    id: '2026-11-10-agency-members-locked',
    async up(db) {
      // Members now join locked and can't send gifts; lock the ones who joined before.
      const { locked } = await lockAgencyMembers(db);
      console.log(`  locked ${locked} agency member(s)`);
    },
  },
  {
    id: '2026-11-11-platform-moderators',
    async up(db) {
      // The in-app platform moderator role starts empty.
      await db.col.users.updateMany(
        { platformModerator: { $exists: false } },
        { $set: { platformModerator: null } },
      );
    },
  },
  {
    id: '2026-11-11-equipped-expiry',
    async up(db) {
      // An owned, equipped item now carries its ownership expiry on the slot, so reads drop it
      // the moment it lapses. Backfill it from the ownership rows; a slot whose ownership is
      // gone gets "already expired", and the next store.sweep takes it off.
      const slots = [
        { id: 'frameId', tier: 'frameVipTier', expires: 'frameExpiresAt' },
        {
          id: 'entryAnimationId',
          tier: 'entryAnimationVipTier',
          expires: 'entryAnimationExpiresAt',
        },
      ] as const;
      const epoch = new Date(0);
      let updated = 0;
      for (const slot of slots) {
        const wearers = db.col.users.find(
          {
            [`equipped.${slot.id}`]: { $type: 'objectId' },
            [`equipped.${slot.tier}`]: { $not: { $gt: 0 } },
            [`equipped.${slot.expires}`]: { $exists: false },
          },
          { projection: { equipped: 1 } },
        );
        for await (const u of wearers) {
          const itemId = (u.equipped as unknown as Record<string, unknown>)[slot.id];
          const owned = await db.col.userCosmetics.findOne(
            { userId: u._id, cosmeticId: itemId as never },
            { projection: { expiresAt: 1 } },
          );
          await db.col.users.updateOne(
            { _id: u._id },
            { $set: { [`equipped.${slot.expires}`]: owned?.expiresAt ?? epoch } },
          );
          updated++;
        }
      }
      console.log(`  backfilled ${updated} equipped slot(s)`);
    },
  },
  {
    // The in-house games are replaced by AsadSoft: refund bets of unsettled rounds, then drop
    // `game_rounds`, `game_bets` and the old `games` registry.
    id: '2026-11-13-asadsoft-games',
    async up(db) {
      const r = await removeInhouseGames(db);
      console.log(
        `  refunded ${r.betsRefunded} open bet(s) (${r.diamondsRefunded} diamonds), voided ${r.betsVoided}; dropped ${r.dropped.join(', ') || 'nothing'}`,
      );
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
