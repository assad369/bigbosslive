/**
 * Seed catalog data for a fresh environment: level ladder, gifts, VIP tiers, cosmetics,
 * recharge packages, and the games registry. Idempotent — existing documents are left alone
 * (matched by natural key), so it is safe to re-run.
 *   npm run seed
 */
import { ObjectId } from 'mongodb';
import { GAME_KEYS } from '@bigboss/shared';
import { GAME_DEFINITIONS } from '../src/modules/games/definitions.js';
import { withDb } from './_db.js';

const CDN = process.env.SEED_ASSET_BASE_URL ?? 'https://cdn.bigbosslive.app/seed';

const TIERS = [
  { from: 1, name: 'Ivory', color: '#BFAE8E' },
  { from: 11, name: 'Bronze', color: '#8C6239' },
  { from: 21, name: 'Silver', color: '#9C9C9C' },
  { from: 31, name: 'Gold', color: '#C9A227' },
  { from: 41, name: 'Champagne', color: '#D8B76A' },
  { from: 51, name: 'Platinum', color: '#7F8C8D' },
  { from: 61, name: 'Royal', color: '#6B4826' },
  { from: 71, name: 'Imperial', color: '#B8860B' },
  { from: 81, name: 'Sovereign', color: '#8B5A00' },
  { from: 91, name: 'Big Boss', color: '#5C3A00' },
];

/** Roughly geometric ladder: level 1 at 1k points, level 100 at ~2B. */
function pointsFor(level: number): number {
  return Math.round((1000 * Math.pow(1.1615, level - 1)) / 100) * 100;
}

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

  // Level ladder
  if ((await db.col.levelConfigs.countDocuments()) === 0) {
    const docs = Array.from({ length: 100 }, (_, i) => {
      const level = i + 1;
      const tier = [...TIERS].reverse().find((t) => level >= t.from)!;
      return {
        _id: level,
        pointsRequired: pointsFor(level),
        name: `${tier.name} ${level - tier.from + 1}`,
        color: tier.color,
        iconUrl: null,
      };
    });
    await db.col.levelConfigs.insertMany(docs);
    console.log('seeded 100 levels');
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
          vipTierRequired: category === 'exclusive' ? 3 : 0,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }
  console.log(`ensured ${GIFTS.length} gifts`);

  // VIP tiers: VIP, VVIP, King. Perks listed here are the ones the app actually delivers.
  const vip = [
    {
      tier: 1,
      name: 'VIP',
      priceDiamonds: 3000,
      perks: ['VIP badge', 'VIP avatar frame', 'Entrance banner'],
      entry: false,
    },
    {
      tier: 2,
      name: 'VVIP',
      priceDiamonds: 9000,
      perks: ['VVIP badge', 'Animated avatar frame', 'Entrance effect', 'Listed above VIP'],
      entry: true,
    },
    {
      tier: 3,
      name: 'King',
      priceDiamonds: 30000,
      perks: [
        'King badge',
        'King avatar frame',
        'Royal entrance effect',
        'Top of Popular and viewer lists',
        'Exclusive gifts',
      ],
      entry: true,
    },
  ];
  for (const [i, { entry, ...v }] of vip.entries()) {
    await db.col.vipPackages.updateOne(
      { tier: v.tier },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          ...v,
          durationDays: 30,
          badgeUrl: `${CDN}/vip/${v.tier}.png`,
          frameUrl: `${CDN}/vip/frame-${v.tier}.svga`,
          frameFormat: 'svga',
          entryAnimationUrl: entry ? `${CDN}/vip/entry-${v.tier}.svga` : null,
          entryAnimationFormat: entry ? 'svga' : 'none',
          active: true,
          sortOrder: i,
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

  // Games registry (disabled until an admin enables them and sets the hosted URL).
  for (const [i, key] of GAME_KEYS.entries()) {
    const def = GAME_DEFINITIONS[key];
    await db.col.games.updateOne(
      { _id: key },
      {
        $setOnInsert: {
          _id: key,
          name: def.name,
          enabled: false,
          url: `https://games.bigbosslive.app/${key.replace('_', '-')}/`,
          iconUrl: null,
          sortOrder: i,
          config: def.defaultConfig,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }
  console.log('seed complete');
});
