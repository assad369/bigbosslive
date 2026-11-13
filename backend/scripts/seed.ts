/**
 * Seed catalog data for a fresh environment: level ladder, gifts, VIP tiers, cosmetics,
 * and recharge packages. (Games come from AsadSoft: Admin → Games → Sync.) Idempotent — existing documents are left alone
 * (matched by natural key), so it is safe to re-run.
 *   npm run seed
 */
import { ObjectId } from 'mongodb';
import { buildDefaultLevels } from '@bigboss/shared';
import { withDb } from './_db.js';

const CDN = process.env.SEED_ASSET_BASE_URL ?? 'https://cdn.bigbosslive.app/seed';

const GIFTS: [name: string, price: number, category: string, animated: boolean][] = [
  ['Rose', 1, 'popular', false],
  ['Champagne Toast', 10, 'popular', false],
  ['Golden Heart', 49, 'popular', false],
  ['Diamond Ring', 99, 'popular', true],
  ['Gold Bar', 199, 'luxury', false],
  ['Crown', 499, 'luxury', true],
  ['Sports Car', 1999, 'luxury', true],
  ['Yacht', 4999, 'luxury', true],
  ['Private Jet', 9999, 'luxury', true],
  ['Golden Palace', 29999, 'luxury', true],
  ['Big Boss Throne', 99999, 'exclusive', true],
];

await withDb(async (db) => {
  const now = new Date();

  // Level ladder: the default 500 levels (packages/shared/src/levels.ts).
  if ((await db.col.levelConfigs.countDocuments()) === 0) {
    const docs = buildDefaultLevels().map(({ level, ...rest }) => ({ _id: level, ...rest }));
    await db.col.levelConfigs.insertMany(docs);
    console.log(`seeded ${docs.length} levels`);
  }

  // Gifts
  for (const [i, [name, price, category, animated]] of GIFTS.entries()) {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    await db.col.gifts.updateOne(
      { name },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          name,
          price,
          iconUrl: `${CDN}/gifts/${slug}.png`,
          animationUrl: animated ? `${CDN}/gifts/${slug}.svga` : null,
          animationFormat: animated ? 'svga' : 'none',
          category,
          sortOrder: i,
          active: true,
          vipTierRequired: category === 'exclusive' ? 4 : 0,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }
  console.log(`ensured ${GIFTS.length} gifts`);

  // Tier packages: two per tier (VIP, VVIP, Crown, King). Each is a badge on the avatar.
  const tierPackages = [
    { tier: 1, name: 'VIP Star', priceDiamonds: 3000 },
    { tier: 1, name: 'VIP Comet', priceDiamonds: 5000 },
    { tier: 2, name: 'VVIP Sun', priceDiamonds: 9000 },
    { tier: 2, name: 'VVIP Phoenix', priceDiamonds: 14000 },
    { tier: 3, name: 'Rose Crown', priceDiamonds: 20000 },
    { tier: 3, name: 'Diamond Crown', priceDiamonds: 26000 },
    { tier: 4, name: 'Royal King', priceDiamonds: 30000 },
    { tier: 4, name: 'Emperor King', priceDiamonds: 45000 },
  ];
  for (const [i, p] of tierPackages.entries()) {
    const slug = p.name.toLowerCase().replace(/\s+/g, '-');
    await db.col.tierPackages.updateOne(
      { name: p.name },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          ...p,
          durationDays: 30,
          badge: {
            imageUrl: `${CDN}/tiers/${slug}.png`,
            svgaUrl: `${CDN}/tiers/${slug}.svga`,
            mp4Url: null,
            blendMode: 'normal',
          },
          active: true,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  // Cosmetics
  const cosmetics = [
    { type: 'frame', name: 'Gilded Laurel', priceDiamonds: 500, durationDays: 7 },
    { type: 'frame', name: 'Champagne Halo', priceDiamonds: 1500, durationDays: 30 },
    { type: 'entry_animation', name: 'Golden Carpet', priceDiamonds: 2000, durationDays: 30 },
    { type: 'room_background', name: 'Ivory Lounge', priceDiamonds: 800, durationDays: 30 },
  ] as const;
  for (const [i, c] of cosmetics.entries()) {
    const slug = c.name.toLowerCase().replace(/\s+/g, '-');
    await db.col.cosmetics.updateOne(
      { name: c.name },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          ...c,
          assetUrl: `${CDN}/cosmetics/${slug}.${c.type === 'room_background' ? 'jpg' : 'svga'}`,
          previewUrl: `${CDN}/cosmetics/${slug}.png`,
          animationFormat: c.type === 'room_background' ? 'none' : 'svga',
          vipTierRequired: 0,
          active: true,
          sortOrder: i,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  // Store packages (SKUs must match Play Console / App Store Connect product ids).
  const packages = [
    [100, 0, 0.99],
    [520, 20, 4.99],
    [1100, 100, 9.99],
    [5800, 800, 49.99],
    [12000, 2000, 99.99],
  ] as const;
  for (const [i, [diamonds, bonus, price]] of packages.entries()) {
    await db.col.rechargePackages.updateOne(
      { sku: `diamonds_${diamonds}` },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          sku: `diamonds_${diamonds}`,
          diamonds,
          bonusDiamonds: bonus,
          priceUsd: price,
          active: true,
          sortOrder: i,
        },
      },
      { upsert: true },
    );
  }

  console.log('seed complete');
});
