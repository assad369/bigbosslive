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
    /** Share of each gift's diamond value the platform keeps. Receiver gets the rest as beans. */
    platformFeeRate: z.number().min(0).max(0.9).default(0.3),
    /** Upper bound applied to any agency's commission rate. */
    maxAgencyRate: z.number().min(0).max(0.5).default(0.1),
    /** Level points per diamond of gifts received (recharges always count 1:1). */
    receivedLevelWeight: z.number().min(0).max(10).default(1),
    beansPerUsd: z.number().int().positive().default(10_000),
    minWithdrawBeans: z.number().int().positive().default(50_000),
    maxGiftQuantity: z.number().int().min(1).max(9999).default(999),
  }),
  features: z.object({
    pkEnabled: z.boolean().default(true),
    gamesEnabled: z.boolean().default(true),
    feedEnabled: z.boolean().default(true),
    audioRoomsEnabled: z.boolean().default(true),
    withdrawalsEnabled: z.boolean().default(true),
    adsEnabled: z.boolean().default(false),
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
  }),
  live: z.object({
    /** A live room with no heartbeat for this long is closed by the sweeper. */
    staleAfterSec: z.number().int().min(30).max(3600).default(90),
    audioSeatCount: z.number().int().min(2).max(16).default(8),
    /** People on a video stage, host included. */
    videoSeatCount: z.number().int().min(2).max(MAX_VIDEO_SEATS).default(9),
    seatRequestTtlSec: z.number().int().min(10).max(600).default(60),
    followerPushOnGoLive: z.boolean().default(true),
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
