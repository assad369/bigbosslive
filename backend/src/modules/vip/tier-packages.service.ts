import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  BADGE_BLEND_MODES,
  MAX_GRANT_DAYS,
  MAX_VIP_TIER,
  MEDIA_EXTENSIONS,
  vipTierLabel,
  type AdminTierPackage,
  type OwnedTierPackage,
  type TierBadge,
  type TierPackage,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { TierBadgeDoc, TierPackageDoc, UserDoc } from '../../db/schema.js';
import { onCommit } from '../../lib/after-commit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { objectIdString } from '../../lib/http.js';
import { once } from '../../lib/idempotency.js';
import { addDays } from '../../lib/time.js';
import { activeVipTier } from '../users/users.presenter.js';

const tierNumber = z.number().int().min(1).max(MAX_VIP_TIER);

export const tierPackageInput = z.object({
  tier: tierNumber,
  name: z.string().trim().min(1).max(40),
  priceDiamonds: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(MAX_GRANT_DAYS),
  badgeUrl: z.url().nullable().default(null),
  badgeSvgaUrl: z.url().nullable().default(null),
  badgeMp4Url: z.url().nullable().default(null),
  badgeBlendMode: z.enum(BADGE_BLEND_MODES).default('normal'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type TierPackageInput = z.infer<typeof tierPackageInput>;

export const tierPackageListQuery = z.object({
  tier: z.coerce.number().int().min(1).max(MAX_VIP_TIER).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  q: z.string().trim().max(40).optional(),
});

export const tierPackageGrantInput = z.object({
  packageId: objectIdString,
  /** Overrides the package's own duration. */
  days: z.number().int().min(1).max(MAX_GRANT_DAYS).optional(),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const IMAGE_EXTENSIONS = new Set(
  Object.entries(MEDIA_EXTENSIONS)
    .filter(([, type]) => type.startsWith('image/'))
    .map(([ext]) => ext),
);

/** The URL's file extension, lower-cased; null when the path has none (signed or CDN URLs). */
function extensionOf(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return last.includes('.') ? (last.split('.').pop()?.toLowerCase() ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Each rendition lives in its own field, so the format is implied by the field: a file in the
 * wrong slot would be handed to the wrong player on every client. A URL whose extension says
 * nothing keeps its slot.
 */
function checkBadge(b: Pick<TierPackageInput, 'badgeUrl' | 'badgeSvgaUrl' | 'badgeMp4Url'>) {
  if (!b.badgeUrl && !b.badgeSvgaUrl && !b.badgeMp4Url)
    throw badRequest('Add the badge artwork: an image, an SVGA or an MP4');
  const slot = (url: string | null, ok: (ext: string) => boolean, what: string) => {
    const ext = url ? extensionOf(url) : null;
    if (ext && !ok(ext)) throw badRequest(`The ${what} slot can't hold a .${ext} file`);
  };
  slot(b.badgeUrl, (e) => IMAGE_EXTENSIONS.has(e), 'image');
  slot(b.badgeSvgaUrl, (e) => e === 'svga', 'SVGA');
  slot(b.badgeMp4Url, (e) => e === 'mp4', 'MP4');
}

function badgeDoc(i: TierPackageInput): TierBadgeDoc {
  return {
    imageUrl: i.badgeUrl,
    svgaUrl: i.badgeSvgaUrl,
    mp4Url: i.badgeMp4Url,
    blendMode: i.badgeBlendMode,
  };
}

function toBadge(b: TierBadgeDoc): TierBadge {
  return {
    imageUrl: b.imageUrl ?? null,
    svgaUrl: b.svgaUrl ?? null,
    mp4Url: b.mp4Url ?? null,
    blendMode: b.blendMode ?? 'normal',
  };
}

export function toTierPackage(p: TierPackageDoc): TierPackage {
  return {
    id: String(p._id),
    tier: p.tier,
    name: p.name,
    priceDiamonds: p.priceDiamonds,
    durationDays: p.durationDays,
    badge: toBadge(p.badge),
    active: p.active,
    sortOrder: p.sortOrder,
  };
}

const EMPTY_SLOT = { tier: 0, expiresAt: null, packageId: null, badge: null };

/**
 * Tier packages (VIP < VVIP < Crown < King): badge artwork sold for a number of days. A user
 * may own many and wears one at a time; the worn one (`users.vip`) sets their tier. This
 * service is the only writer of `users.vip`.
 */
export class TierPackagesService {
  constructor(private readonly ctx: Ctx) {}

  // ── Catalog ────────────────────────────────────────────────────────────────

  /** The shop: active packages, optionally of one tier. */
  async list(tier?: number): Promise<TierPackage[]> {
    const docs = await this.ctx.col.tierPackages
      .find({ active: true, ...(tier ? { tier } : {}) })
      .sort({ tier: -1, sortOrder: 1, priceDiamonds: 1, _id: 1 })
      .toArray();
    return docs.map(toTierPackage);
  }

  /** The admin catalog: paged and filtered, with how many users hold each package now. */
  async adminList(
    q: z.infer<typeof tierPackageListQuery>,
    page: number,
    pageSize: number,
  ): Promise<{ items: AdminTierPackage[]; total: number; page: number; pageSize: number }> {
    const filter: Filter<TierPackageDoc> = {};
    if (q.tier) filter.tier = q.tier;
    if (q.status) filter.active = q.status === 'active';
    if (q.q) filter.name = { $regex: escapeRegex(q.q), $options: 'i' };
    const [docs, total] = await Promise.all([
      this.ctx.col.tierPackages
        .find(filter)
        .sort({ tier: -1, sortOrder: 1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.tierPackages.countDocuments(filter),
    ]);
    const counts = docs.length
      ? await this.ctx.col.userTierPackages
          .aggregate<{ _id: ObjectId; n: number }>([
            {
              $match: {
                packageId: { $in: docs.map((d) => d._id) },
                expiresAt: { $gt: this.ctx.clock.now() },
              },
            },
            { $group: { _id: '$packageId', n: { $sum: 1 } } },
          ])
          .toArray()
      : [];
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    return {
      items: docs.map((d) => ({
        ...toTierPackage(d),
        ownerCount: byId.get(String(d._id)) ?? 0,
        createdAt: d.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async create(input: TierPackageInput): Promise<TierPackage> {
    checkBadge(input);
    const now = this.ctx.clock.now();
    const doc: TierPackageDoc = {
      _id: new ObjectId(),
      tier: input.tier,
      name: input.name,
      priceDiamonds: input.priceDiamonds,
      durationDays: input.durationDays,
      badge: badgeDoc(input),
      active: input.active,
      sortOrder: input.sortOrder,
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.col.tierPackages.insertOne(doc);
    return toTierPackage(doc);
  }

  /** Apply the fields sent. The tier never changes; wearers pick up new artwork at once. */
  async update(id: ObjectId, patch: Partial<TierPackageInput>): Promise<TierPackage> {
    const before = await this.ctx.col.tierPackages.findOne({ _id: id });
    if (!before) throw notFound('Tier package');
    if (patch.tier !== undefined && patch.tier !== before.tier)
      throw badRequest("A package's tier can't change; create a new one instead");
    const merged: TierPackageInput = {
      tier: before.tier,
      name: patch.name ?? before.name,
      priceDiamonds: patch.priceDiamonds ?? before.priceDiamonds,
      durationDays: patch.durationDays ?? before.durationDays,
      badgeUrl: patch.badgeUrl !== undefined ? patch.badgeUrl : before.badge.imageUrl,
      badgeSvgaUrl: patch.badgeSvgaUrl !== undefined ? patch.badgeSvgaUrl : before.badge.svgaUrl,
      badgeMp4Url: patch.badgeMp4Url !== undefined ? patch.badgeMp4Url : before.badge.mp4Url,
      badgeBlendMode: patch.badgeBlendMode ?? before.badge.blendMode,
      active: patch.active ?? before.active,
      sortOrder: patch.sortOrder ?? before.sortOrder,
    };
    checkBadge(merged);
    const badge = badgeDoc(merged);
    const after = await this.ctx.col.tierPackages.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          name: merged.name,
          priceDiamonds: merged.priceDiamonds,
          durationDays: merged.durationDays,
          badge,
          active: merged.active,
          sortOrder: merged.sortOrder,
          updatedAt: this.ctx.clock.now(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!after) throw notFound('Tier package');
    // Artwork is copied onto the worn slot: re-sync everyone wearing it.
    await this.ctx.col.users.updateMany({ 'vip.packageId': id }, { $set: { 'vip.badge': badge } });
    return toTierPackage(after);
  }

  /**
   * Delete a package nobody holds (a mistaken upload). One in use is deactivated instead, so
   * holders keep wearing it until it expires.
   */
  async remove(id: ObjectId): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      const pkg = await this.ctx.col.tierPackages.findOne({ _id: id }, { session });
      if (!pkg) throw notFound('Tier package');
      const [owners, wearers] = await Promise.all([
        this.ctx.col.userTierPackages.countDocuments(
          { packageId: id, expiresAt: { $gt: this.ctx.clock.now() } },
          { session },
        ),
        this.ctx.col.users.countDocuments({ 'vip.packageId': id }, { session }),
      ]);
      const inUse = Math.max(owners, wearers);
      if (inUse)
        throw conflict(`Held by ${inUse} user${inUse === 1 ? '' : 's'}. Deactivate it instead.`);
      await this.ctx.col.userTierPackages.deleteMany({ packageId: id }, { session });
      await this.ctx.col.tierPackages.deleteOne({ _id: id }, { session });
    });
  }

  // ── Holding & wearing ────────────────────────────────────────────────────────

  /** Add `days` to the user's hold on `pkg`, extending an unexpired one. Returns the expiry. */
  private async addHold(
    session: ClientSession,
    uid: string,
    pkg: TierPackageDoc,
    days: number,
    source: 'purchase' | 'admin',
    grantedBy: string | null,
  ): Promise<Date> {
    const now = this.ctx.clock.now();
    const held = await this.ctx.col.userTierPackages.findOne(
      { userId: uid, packageId: pkg._id },
      { session },
    );
    const holding = !!held && held.expiresAt > now;
    const expiresAt = addDays(holding ? held.expiresAt : now, days);
    await this.ctx.col.userTierPackages.updateOne(
      { userId: uid, packageId: pkg._id },
      {
        $set: {
          expiresAt,
          tier: pkg.tier,
          source,
          grantedBy,
          ...(holding ? {} : { acquiredAt: now }),
        },
        $setOnInsert: { userId: uid, packageId: pkg._id },
      },
      { upsert: true, session },
    );
    return expiresAt;
  }

  /**
   * Write the worn slot, re-rank the user's live room, and after commit refresh what the
   * room shows of them. `pkg` null takes the package off.
   */
  private async writeSlot(
    session: ClientSession,
    uid: string,
    pkg: TierPackageDoc | null,
    expiresAt: Date | null,
  ): Promise<void> {
    const vip: UserDoc['vip'] = pkg
      ? { tier: pkg.tier, expiresAt, packageId: pkg._id, badge: pkg.badge }
      : EMPTY_SLOT;
    await this.ctx.col.users.updateOne({ _id: uid }, { $set: { vip } }, { session });
    await this.ctx.col.liveRooms.updateOne(
      { hostId: uid, status: 'live' },
      { $set: { hostVipTier: vip.tier } },
      { session },
    );
    onCommit(session, () => this.ctx.services.live.refreshIdentity(uid), `tier-slot:${uid}`);
  }

  /** Buy (or renew) a package and wear it. Keyed by the client's `Idempotency-Key`. */
  async purchase(uid: string, packageId: ObjectId, key: string) {
    const pkg = await this.ctx.col.tierPackages.findOne({ _id: packageId, active: true });
    if (!pkg) throw notFound('Tier package');
    const { result, replayed } = await once(this.ctx, 'tier_package', uid, key, async (session) => {
      const user = await this.ctx.col.users.findOne(
        { _id: uid },
        { session, projection: { wallet: 1 } },
      );
      if (!user) throw notFound('User');
      let diamonds = user.wallet.diamonds;
      if (pkg.priceDiamonds > 0)
        diamonds = await this.ctx.services.wallet.debit(session, {
          uid,
          currency: 'diamonds',
          amount: pkg.priceDiamonds,
          reason: 'vip_purchase',
          refId: String(pkg._id),
          meta: { tier: pkg.tier, name: pkg.name, days: pkg.durationDays },
        });
      const expiresAt = await this.addHold(session, uid, pkg, pkg.durationDays, 'purchase', null);
      await this.writeSlot(session, uid, pkg, expiresAt);
      return {
        packageId: String(pkg._id),
        tier: pkg.tier,
        expiresAt: expiresAt.toISOString(),
        diamonds,
      };
    });
    return { ...result, replayed };
  }

  /** Wear an owned, unexpired package (any tier, including a lower one); null takes it off. */
  async wear(uid: string, packageId: ObjectId | null): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      if (!packageId) {
        await this.writeSlot(session, uid, null, null);
        return;
      }
      const now = this.ctx.clock.now();
      const held = await this.ctx.col.userTierPackages.findOne(
        { userId: uid, packageId },
        { session },
      );
      if (!held) throw forbidden('You do not own this package');
      if (held.expiresAt <= now) throw badRequest('This package has expired');
      const pkg = await this.ctx.col.tierPackages.findOne({ _id: packageId }, { session });
      if (!pkg) throw notFound('Tier package');
      await this.writeSlot(session, uid, pkg, held.expiresAt);
    });
  }

  /** A user's packages, newest first, with the worn one marked. */
  async mine(uid: string, tier?: number): Promise<OwnedTierPackage[]> {
    const now = this.ctx.clock.now();
    const user = await this.ctx.col.users.findOne({ _id: uid }, { projection: { vip: 1 } });
    if (!user) throw notFound('User');
    const rows = await this.ctx.col.userTierPackages
      .find({ userId: uid, ...(tier ? { tier } : {}) })
      .sort({ expiresAt: -1, _id: -1 })
      .toArray();
    const pkgs = rows.length
      ? await this.ctx.col.tierPackages
          .find({ _id: { $in: rows.map((r) => r.packageId) } })
          .toArray()
      : [];
    const byId = new Map(pkgs.map((p) => [String(p._id), p]));
    const wornId = activeVipTier(user.vip, now) && user.vip.packageId ? user.vip.packageId : null;
    const out: OwnedTierPackage[] = [];
    for (const r of rows) {
      const pkg = byId.get(String(r.packageId));
      if (!pkg) continue;
      out.push({
        package: toTierPackage(pkg),
        acquiredAt: r.acquiredAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        expired: r.expiresAt <= now,
        worn: !!wornId && wornId.equals(r.packageId),
        source: r.source,
        grantedBy: r.grantedBy ?? null,
      });
    }
    return out;
  }

  /**
   * Admin grant: add `days` (default: the package's duration) and wear it at once. No
   * diamonds move. Inactive packages may be granted (event-only artwork). Keyed per admin.
   */
  async grant(
    uid: string,
    packageId: ObjectId,
    days: number | undefined,
    adminUid: string,
    key: string,
  ) {
    const pkg = await this.ctx.col.tierPackages.findOne({ _id: packageId });
    if (!pkg) throw notFound('Tier package');
    const grantDays = days ?? pkg.durationDays;
    const { result, replayed } = await once(
      this.ctx,
      'tier_package_grant',
      uid,
      `${adminUid}:${key}`,
      async (session) => {
        const user = await this.ctx.col.users.findOne(
          { _id: uid },
          { session, projection: { _id: 1 } },
        );
        if (!user) throw notFound('User');
        const expiresAt = await this.addHold(session, uid, pkg, grantDays, 'admin', adminUid);
        await this.writeSlot(session, uid, pkg, expiresAt);
        return {
          packageId: String(pkg._id),
          name: pkg.name,
          tier: pkg.tier,
          tierLabel: vipTierLabel(pkg.tier),
          days: grantDays,
          expiresAt: expiresAt.toISOString(),
        };
      },
    );
    return { ...result, replayed };
  }

  /** Take back a package; it comes off if it was being worn. */
  async revoke(uid: string, packageId: ObjectId): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      const removed = await this.ctx.col.userTierPackages.findOneAndDelete(
        { userId: uid, packageId },
        { session },
      );
      if (!removed) throw notFound('This user does not own that package');
      const user = await this.ctx.col.users.findOne(
        { _id: uid, 'vip.packageId': packageId },
        { session, projection: { _id: 1 } },
      );
      if (user) await this.writeSlot(session, uid, null, null);
    });
  }

  /**
   * Clear worn slots whose package expired and drop their hosts' Popular rank. Reads already
   * treat them as none (`activeVipTier`); this keeps stored state honest. Hourly job.
   */
  async sweep(): Promise<number> {
    const now = this.ctx.clock.now();
    const expired = await this.ctx.col.users
      .find({ 'vip.tier': { $gt: 0 }, 'vip.expiresAt': { $lte: now } }, { projection: { _id: 1 } })
      .limit(5000)
      .toArray();
    let cleared = 0;
    for (const { _id: uid } of expired) {
      await this.ctx.db.withTransaction(async (session) => {
        const res = await this.ctx.col.users.updateOne(
          { _id: uid, 'vip.tier': { $gt: 0 }, 'vip.expiresAt': { $lte: now } },
          { $set: { vip: EMPTY_SLOT } },
          { session },
        );
        if (!res.modifiedCount) return;
        cleared += 1;
        await this.ctx.col.liveRooms.updateOne(
          { hostId: uid, status: 'live' },
          { $set: { hostVipTier: 0 } },
          { session },
        );
        onCommit(session, () => this.ctx.services.live.refreshIdentity(uid), `tier-slot:${uid}`);
      });
    }
    return cleared;
  }
}
