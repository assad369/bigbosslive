import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { AppError, badRequest } from '../../lib/errors.js';
import type { UserBrief } from '../users/users.presenter.js';

/**
 * Kept outside `CONFIG_SCHEMAS`, so neither the public `/config/app` nor the generic
 * `/admin/config` listing ever includes the uids.
 */
const DOC_ID = 'maintenance_access';
const CACHE_TTL_MS = 30_000;
export const MAX_MAINTENANCE_ACCESS = 1000;
const DEFAULT_MESSAGE = 'BigBoss Live is under maintenance. Please check back shortly.';

const stored = z.object({ uids: z.array(z.string()).default([]) });

/**
 * Users who may keep using the app while `app.maintenance` is on. Everyone else is turned
 * away by `requireAuth`, the session bootstrap and the socket handshake. Other replicas pick
 * up a change within the cache TTL.
 */
export class MaintenanceService {
  private cache: { value: Set<string>; at: number } | null = null;

  constructor(private readonly ctx: Ctx) {}

  private async uids(): Promise<string[]> {
    const doc = await this.ctx.col.appConfig.findOne({ _id: DOC_ID });
    const parsed = stored.safeParse(doc?.value ?? {});
    if (!parsed.success) {
      this.ctx.log.error({ issues: parsed.error.issues }, 'stored maintenance access invalid');
      return [];
    }
    return parsed.data.uids;
  }

  async allowed(): Promise<Set<string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const value = new Set(await this.uids());
    this.cache = { value, at: Date.now() };
    return value;
  }

  /** On the list, whether or not maintenance is on right now. */
  async hasAccess(uid: string): Promise<boolean> {
    return (await this.allowed()).has(uid);
  }

  /** Maintenance is on and this user is not on the list. */
  async blocks(uid: string): Promise<boolean> {
    const app = await this.ctx.services.config.get('app');
    return app.maintenance && !(await this.hasAccess(uid));
  }

  async assertOpen(uid: string): Promise<void> {
    const app = await this.ctx.services.config.get('app');
    if (!app.maintenance || (await this.hasAccess(uid))) return;
    throw new AppError(503, 'maintenance', app.maintenanceMessage || DEFAULT_MESSAGE);
  }

  /** The list, oldest first. Accounts deleted since they were added are left out. */
  async list(): Promise<UserBrief[]> {
    const uids = await this.uids();
    const briefs = await this.ctx.services.users.briefs(uids);
    return uids.flatMap((uid) => {
      const b = briefs.get(uid);
      return b ? [b] : [];
    });
  }

  /** Each identifier is a short id or a uid. Ones that match no active user are returned. */
  async add(
    identifiers: string[],
    adminId: string,
  ): Promise<{ added: UserBrief[]; notFound: string[] }> {
    const found: string[] = [];
    const notFound: string[] = [];
    for (const raw of [...new Set(identifiers.map((i) => i.trim()).filter(Boolean))]) {
      try {
        found.push((await this.ctx.services.users.resolve(raw))._id);
      } catch (err) {
        if (err instanceof AppError && err.code === 'not_found') notFound.push(raw);
        else throw err;
      }
    }
    const current = await this.uids();
    const fresh = [...new Set(found)].filter((uid) => !current.includes(uid));
    if (current.length + fresh.length > MAX_MAINTENANCE_ACCESS) {
      throw badRequest(`At most ${MAX_MAINTENANCE_ACCESS} users can have maintenance access`);
    }
    if (fresh.length) {
      await this.ctx.col.appConfig.updateOne(
        { _id: DOC_ID },
        {
          $addToSet: { 'value.uids': { $each: fresh } },
          $set: { updatedAt: this.ctx.clock.now(), updatedBy: adminId },
        },
        { upsert: true },
      );
      this.cache = null;
    }
    const briefs = await this.ctx.services.users.briefs(fresh);
    return { added: fresh.flatMap((uid) => briefs.get(uid) ?? []), notFound };
  }

  async remove(uid: string, adminId: string): Promise<void> {
    await this.ctx.col.appConfig.updateOne(
      { _id: DOC_ID },
      {
        $pull: { 'value.uids': uid },
        $set: { updatedAt: this.ctx.clock.now(), updatedBy: adminId },
      },
    );
    this.cache = null;
  }
}
