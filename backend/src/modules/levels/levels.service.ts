import type { AnyBulkWriteOperation, ClientSession } from 'mongodb';
import { z } from 'zod';
import type { LevelProgress } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LevelConfigDoc, UserDoc } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';

export const levelConfigInput = z.object({
  level: z.number().int().min(1).max(100),
  pointsRequired: z.number().int().min(0),
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  iconUrl: z.url().nullable().default(null),
});
export type LevelConfigInput = z.infer<typeof levelConfigInput>;

const CACHE_TTL_MS = 60_000;

/**
 * The level rule: points = totalRecharged + floor(totalReceived × receivedLevelWeight).
 * Nothing else moves level — not gifts sent, game bets, cosmetic purchases or agency
 * commission. Thresholds live in `level_configs` and are never hard-coded.
 */
export class LevelsService {
  private cache: { configs: LevelConfigDoc[]; at: number } | null = null;

  constructor(private readonly ctx: Ctx) {}

  async configs(): Promise<LevelConfigDoc[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.configs;
    const configs = await this.ctx.col.levelConfigs.find().sort({ _id: 1 }).toArray();
    this.cache = { configs, at: Date.now() };
    return configs;
  }

  invalidate(): void {
    this.cache = null;
  }

  static pointsFor(stats: Pick<UserDoc['stats'], 'totalRecharged' | 'totalReceived'>, weight: number): number {
    return stats.totalRecharged + Math.floor(stats.totalReceived * weight);
  }

  static levelFor(points: number, configs: LevelConfigDoc[]): number {
    let level = 0;
    for (const c of configs) {
      if (points >= c.pointsRequired) level = c._id;
      else break;
    }
    return level;
  }

  async progress(user: Pick<UserDoc, 'stats'>): Promise<LevelProgress> {
    const [configs, economy] = await Promise.all([this.configs(), this.ctx.services.config.get('economy')]);
    const points = LevelsService.pointsFor(user.stats, economy.receivedLevelWeight);
    const level = LevelsService.levelFor(points, configs);
    const current = configs.find((c) => c._id === level);
    const next = configs.find((c) => c._id > level);
    return {
      level,
      points,
      currentLevelPoints: current?.pointsRequired ?? 0,
      nextLevelPoints: next?.pointsRequired ?? null,
      isMaxLevel: !next,
    };
  }

  /**
   * Recompute and persist a user's level from their counters. Call inside the same transaction
   * that moved `totalRecharged` / `totalReceived`, passing that session, so the level can never
   * drift from the counters.
   */
  async recalculate(uid: string, session?: ClientSession): Promise<{ level: number; points: number; changed: boolean }> {
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { stats: 1, level: 1 }, ...(session ? { session } : {}) },
    );
    if (!user) return { level: 0, points: 0, changed: false };
    const [configs, economy] = await Promise.all([this.configs(), this.ctx.services.config.get('economy')]);
    const points = LevelsService.pointsFor(user.stats, economy.receivedLevelWeight);
    const level = LevelsService.levelFor(points, configs);
    const changed = level !== user.level.level || points !== user.level.points;
    if (changed) {
      await this.ctx.col.users.updateOne(
        { _id: uid },
        { $set: { level: { level, points } } },
        session ? { session } : {},
      );
    }
    return { level, points, changed };
  }

  /** Replace the whole ladder atomically. Thresholds must be strictly increasing. */
  async replaceAll(inputs: LevelConfigInput[]): Promise<LevelConfigDoc[]> {
    const sorted = [...inputs].sort((a, b) => a.level - b.level);
    const seen = new Set<number>();
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      if (seen.has(cur.level)) throw badRequest(`Duplicate level ${cur.level}`);
      seen.add(cur.level);
      const prev = sorted[i - 1];
      if (prev && cur.pointsRequired <= prev.pointsRequired) {
        throw badRequest(`Level ${cur.level} must require more points than level ${prev.level}`);
      }
    }
    const docs: LevelConfigDoc[] = sorted.map((c) => ({
      _id: c.level,
      pointsRequired: c.pointsRequired,
      name: c.name,
      color: c.color,
      iconUrl: c.iconUrl,
    }));
    await this.ctx.db.withTransaction(async (session) => {
      await this.ctx.col.levelConfigs.deleteMany({}, { session });
      if (docs.length) await this.ctx.col.levelConfigs.insertMany(docs, { session });
    });
    this.invalidate();
    return docs;
  }

  /** Re-level every user from stored counters (after a ladder or weight change). */
  async relevelAll(): Promise<{ scanned: number; updated: number }> {
    const [configs, economy] = await Promise.all([this.configs(), this.ctx.services.config.get('economy')]);
    let scanned = 0;
    let updated = 0;
    const cursor = this.ctx.col.users.find({}, { projection: { stats: 1, level: 1 } });
    let ops: AnyBulkWriteOperation<UserDoc>[] = [];
    for await (const u of cursor) {
      scanned++;
      const points = LevelsService.pointsFor(u.stats, economy.receivedLevelWeight);
      const level = LevelsService.levelFor(points, configs);
      if (level !== u.level.level || points !== u.level.points) {
        // Conditional on the counters we read, so a concurrent credit is never overwritten.
        ops.push({
          updateOne: {
            filter: { _id: u._id, 'stats.totalRecharged': u.stats.totalRecharged, 'stats.totalReceived': u.stats.totalReceived },
            update: { $set: { level: { level, points } } },
          },
        });
      }
      if (ops.length >= 500) {
        updated += (await this.ctx.col.users.bulkWrite(ops)).modifiedCount;
        ops = [];
      }
    }
    if (ops.length) updated += (await this.ctx.col.users.bulkWrite(ops)).modifiedCount;
    return { scanned, updated };
  }
}
