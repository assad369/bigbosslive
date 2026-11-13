import { z } from 'zod';
import { MAX_VIDEO_SEATS } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Admin-editable runtime configuration, stored in `app_config` as one document per key.
 * Every key has a zod schema with defaults, so a missing or partial document still yields a
 * complete, valid config — and an admin can never save a value the server cannot read.
 */
export const CONFIG_SCHEMAS = {
  economy: z.object({
    /** Share of each gift's diamond value the platform keeps. Receiver gets the rest as diamonds. */
    platformFeeRate: z.number().min(0).max(0.9).default(0.3),
    /** Upper bound applied to any agency's commission rate. */
    maxAgencyRate: z.number().min(0).max(0.5).default(0.1),
    /** Level points per diamond of gifts received (recharges always count 1:1). */
    receivedLevelWeight: z.number().min(0).max(10).default(1),
    /**
     * Withdrawal rate. Any diamond can be withdrawn, bought ones included, so this must keep a
     * withdrawn diamond worth less than a recharged one, or recharge-then-withdraw pays out.
     */
    diamondsPerUsd: z.number().int().positive().default(10_000),
    minWithdrawDiamonds: z.number().int().positive().default(50_000),
    maxGiftQuantity: z.number().int().min(1).max(9999).default(999),
  }),
  features: z.object({
    pkEnabled: z.boolean().default(true),
    /**
     * AsadSoft games, everywhere. Off: the app lists none, launch refuses, open sessions are
     * ended and every new stake is refused at the wallet callback (wins still pay).
     */
    gamesEnabled: z.boolean().default(true),
    feedEnabled: z.boolean().default(true),
    audioRoomsEnabled: z.boolean().default(true),
    withdrawalsEnabled: z.boolean().default(true),
    adsEnabled: z.boolean().default(false),
    /** Hosts and room admins play YouTube songs in a live (needs YOUTUBE_API_KEY). */
    youtubeEnabled: z.boolean().default(false),
  }),
  app: z.object({
    minSupportedBuild: z
      .object({ android: z.number().int().min(0), ios: z.number().int().min(0) })
      .default({ android: 0, ios: 0 }),
    latestVersion: z.string().default('1.0.0'),
    maintenance: z.boolean().default(false),
    maintenanceMessage: z.string().max(500).default(''),
    supportEmail: z.string().default('support@bigbosslive.app'),
    termsUrl: z.string().default('https://bigbosslive.app/terms'),
    privacyUrl: z.string().default('https://bigbosslive.app/privacy'),
    /** Display only: a wallet shows one star per this many diamonds (1 lakh by default). */
    diamondsPerStar: z.number().int().positive().default(100_000),
  }),
  live: z.object({
    /** A live room with no heartbeat for this long is closed by the sweeper. */
    staleAfterSec: z.number().int().min(30).max(3600).default(90),
    audioSeatCount: z.number().int().min(2).max(16).default(8),
    /** People on a video stage, host included. */
    videoSeatCount: z.number().int().min(2).max(MAX_VIDEO_SEATS).default(9),
    seatRequestTtlSec: z.number().int().min(10).max(600).default(60),
    followerPushOnGoLive: z.boolean().default(true),
    /** Gifts worth at least this many diamonds are announced in every live room (0 = all). */
    giftBannerMinDiamonds: z.number().int().min(0).max(100_000_000).default(0),
  }),
  moderation: z.object({
    /** Extra words masked in chat, comments, posts and profile text (case-insensitive). */
    blockedWords: z.array(z.string().trim().min(2).max(40)).max(2000).default([]),
    /** Reject text containing phone numbers or URLs (anti-solicitation). */
    blockContactInfo: z.boolean().default(true),
  }),
  pk: z.object({
    /** Allowed round lengths. */
    durationsSec: z.array(z.number().int().min(60).max(1800)).min(1).default([60, 180, 300, 600]),
    inviteTtlSec: z.number().int().min(10).max(120).default(30),
    /** A battle is decided by rounds won; it ends early once one host has a majority. */
    maxRounds: z.number().int().min(1).max(10).default(3),
    /** Countdown before each round during which gifts do not score. */
    leadInSec: z.number().int().min(0).max(10).default(3),
    /** Between rounds, the battle ends if no host starts the next round within this time. */
    pauseTimeoutSec: z.number().int().min(10).max(900).default(120),
  }),
  /**
   * Platform moderators (app users with `users.platformModerator`). Private: the app only
   * learns the two switches through `/me.moderation`, and only for people who moderate.
   */
  platformModerators: z.object({
    /**
     * Platform moderators join lives as hidden LiveKit participants: no viewer count, join
     * line or entrance. Turning it off does not reveal one already connected.
     */
    stealthEnabled: z.boolean().default(false),
    /** Platform moderators may take a free seat without the host's approval. */
    selfStageEnabled: z.boolean().default(false),
    /** Account and device bans one platform moderator may issue per hour. */
    banRateLimitPerHour: z.number().int().min(1).max(500).default(30),
  }),
  /**
   * AsadSoft games rules (`features.gamesEnabled` is the master switch). Only
   * `liveRoomEnabled` reaches the app, as the `gamesInLive` feature of `/config/app`.
   */
  games: z.object({
    /** Lowest user level allowed to play. A game's own `minLevel` overrides it. */
    minLevel: z.number().int().min(0).max(999).default(0),
    /** Offer games in the live room's Games sheet. */
    liveRoomEnabled: z.boolean().default(true),
    /** List games the player's level doesn't reach yet, with a lock (else hide them). */
    showLocked: z.boolean().default(true),
  }),
  /** YouTube music in lives (`features.youtubeEnabled`). Private: never sent to the app. */
  youtube: z.object({
    /** YouTube's own filter for search results. */
    safeSearch: z.enum(['none', 'moderate', 'strict']).default('moderate'),
    /** ISO country code videos are checked against ('' = no region check). */
    regionCode: z
      .union([z.literal(''), z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code, like BD')])
      .default(''),
    /** Longest song accepted, in seconds. */
    maxDurationSec: z
      .number()
      .int()
      .min(60)
      .max(3 * 3600)
      .default(900),
    /** How long a search is answered from the cache (a search costs 100 of 10,000 daily units). */
    searchCacheSec: z
      .number()
      .int()
      .min(300, 'At least 5 minutes, or the quota runs out')
      .max(7 * 86_400)
      .default(21_600),
    blockedVideoIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'A YouTube video id has 11 characters'))
      .max(5000)
      .default([]),
    blockedChannelIds: z
      .array(z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, 'A channel id starts with UC'))
      .max(5000)
      .default([]),
  }),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
export type ConfigValue<K extends ConfigKey> = z.output<(typeof CONFIG_SCHEMAS)[K]>;

const CACHE_TTL_MS = 30_000;

export class ConfigService {
  private cache = new Map<ConfigKey, { value: unknown; at: number }>();

  constructor(private readonly ctx: Ctx) {}

  async get<K extends ConfigKey>(key: K): Promise<ConfigValue<K>> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as ConfigValue<K>;
    const doc = await this.ctx.col.appConfig.findOne({ _id: key });
    const parsed = CONFIG_SCHEMAS[key].safeParse(doc?.value ?? {});
    // A stored value that no longer validates (schema evolved) falls back to defaults, loudly.
    if (!parsed.success)
      this.ctx.log.error({ key, issues: parsed.error.issues }, 'stored config invalid');
    const value = (parsed.success ? parsed.data : CONFIG_SCHEMAS[key].parse({})) as ConfigValue<K>;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async set<K extends ConfigKey>(key: K, input: unknown, adminId: string): Promise<ConfigValue<K>> {
    const parsed = CONFIG_SCHEMAS[key].safeParse(input);
    if (!parsed.success) {
      throw badRequest(
        `Invalid ${key} config`,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    await this.ctx.col.appConfig.updateOne(
      { _id: key },
      { $set: { value: parsed.data, updatedAt: this.ctx.clock.now(), updatedBy: adminId } },
      { upsert: true },
    );
    this.cache.delete(key);
    return parsed.data as ConfigValue<K>;
  }

  async all(): Promise<{ [K in ConfigKey]: ConfigValue<K> }> {
    const keys = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];
    const values = await Promise.all(keys.map((k) => this.get(k)));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as {
      [K in ConfigKey]: ConfigValue<K>;
    };
  }

  invalidate(): void {
    this.cache.clear();
  }
}
