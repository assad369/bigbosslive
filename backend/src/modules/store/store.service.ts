import { ObjectId, type ClientSession } from 'mongodb';
import { z } from 'zod';
import {
  ANIMATION_FORMATS,
  COSMETIC_TYPES,
  type Cosmetic,
  type CosmeticType,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { CosmeticDoc, VipPackageDoc } from '../../db/schema.js';
import {
  badRequest,
  conflict,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { once } from '../../lib/idempotency.js';
import { addDays } from '../../lib/time.js';
import { activeVipTier } from '../users/users.presenter.js';

export const vipPackageInput = z.object({
  tier: z.number().int().min(1).max(10),
  name: z.string().trim().min(1).max(40),
  priceDiamonds: z.number().int().positive(),
  durationDays: z.number().int().min(1).max(366),
  perks: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  badgeUrl: z.url().nullable().default(null),
  frameUrl: z.url().nullable().default(null),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const cosmeticInput = z.object({
  type: z.enum(COSMETIC_TYPES),
  name: z.string().trim().min(1).max(40),
  assetUrl: z.url(),
  previewUrl: z.url().nullable().default(null),
  animationFormat: z.enum(ANIMATION_FORMATS).default('none'),
  priceDiamonds: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(3650),
  vipTierRequired: z.number().int().min(0).max(10).default(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export function toCosmetic(c: CosmeticDoc): Cosmetic {
  return {
    id: String(c._id),
    type: c.type,
    name: c.name,
    assetUrl: c.assetUrl,
    previewUrl: c.previewUrl,
    animationFormat: c.animationFormat,
    priceDiamonds: c.priceDiamonds,
    durationDays: c.durationDays,
    vipTierRequired: c.vipTierRequired,
    active: c.active,
  };
}

/** VIP memberships and cosmetics (avatar frames, entry animations, room backgrounds, bubbles). */
export class StoreService {
  constructor(private readonly ctx: Ctx) {}

  // ── VIP ──────────────────────────────────────────────────────────────────

  async vipPackages(includeInactive = false): Promise<VipPackageDoc[]> {
    return this.ctx.col.vipPackages
      .find(includeInactive ? {} : { active: true })
      .sort({ tier: 1 })
      .toArray();
  }

  async upsertVipPackage(
    id: ObjectId | null,
    input: z.infer<typeof vipPackageInput>,
  ): Promise<VipPackageDoc> {
    try {
      if (!id) {
        const doc: VipPackageDoc = { _id: new ObjectId(), ...input };
        await this.ctx.col.vipPackages.insertOne(doc);
        return doc;
      }
      const res = await this.ctx.col.vipPackages.findOneAndUpdate(
        { _id: id },
        { $set: input },
        { returnDocument: 'after' },
      );
      if (!res) throw notFound('VIP package');
      return res;
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw conflict(`A package for VIP ${input.tier} already exists`);
      throw err;
    }
  }

  /**
   * Buy or renew VIP. Renewing the active tier extends from the current expiry; upgrading
   * starts fresh from now; buying a lower tier than the active one is refused.
   */
  async purchaseVip(uid: string, packageId: ObjectId, key: string) {
    const pkg = await this.ctx.col.vipPackages.findOne({ _id: packageId, active: true });
    if (!pkg) throw notFound('VIP package');
    const { result, replayed } = await once(this.ctx, 'vip', uid, key, async (session) => {
      const user = await this.ctx.col.users.findOne(
        { _id: uid },
        { session, projection: { vip: 1 } },
      );
      if (!user) throw notFound('User');
      const now = this.ctx.clock.now();
      const current = activeVipTier(user.vip, now);
      if (current > pkg.tier) throw badRequest(`You already have VIP ${current}`);
      const base = current === pkg.tier && user.vip.expiresAt ? user.vip.expiresAt : now;
      const expiresAt = addDays(base, pkg.durationDays);
      const diamonds = await this.ctx.services.wallet.debit(session, {
        uid,
        currency: 'diamonds',
        amount: pkg.priceDiamonds,
        reason: 'vip_purchase',
        refId: String(pkg._id),
        meta: { tier: pkg.tier, days: pkg.durationDays },
      });
      await this.ctx.col.users.updateOne(
        { _id: uid },
        { $set: { vip: { tier: pkg.tier, expiresAt } } },
        { session },
      );
      return { tier: pkg.tier, expiresAt: expiresAt.toISOString(), diamonds };
    });
    return { ...result, replayed };
  }

  // ── Cosmetics ───────────────────────────────────────────────────────────────

  async cosmetics(type: CosmeticType | undefined, includeInactive = false): Promise<Cosmetic[]> {
    const docs = await this.ctx.col.cosmetics
      .find({ ...(type ? { type } : {}), ...(includeInactive ? {} : { active: true }) })
      .sort({ type: 1, sortOrder: 1 })
      .toArray();
    return docs.map(toCosmetic);
  }

  async upsertCosmetic(
    id: ObjectId | null,
    input: z.infer<typeof cosmeticInput>,
  ): Promise<Cosmetic> {
    if (!id) {
      const doc: CosmeticDoc = { _id: new ObjectId(), ...input, createdAt: this.ctx.clock.now() };
      await this.ctx.col.cosmetics.insertOne(doc);
      return toCosmetic(doc);
    }
    const res = await this.ctx.col.cosmetics.findOneAndUpdate(
      { _id: id },
      { $set: input },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Cosmetic');
    return toCosmetic(res);
  }

  async purchaseCosmetic(uid: string, cosmeticId: ObjectId, key: string) {
    const item = await this.ctx.col.cosmetics.findOne({ _id: cosmeticId, active: true });
    if (!item) throw notFound('Item');
    const { result, replayed } = await once(this.ctx, 'cosmetic', uid, key, async (session) => {
      const user = await this.ctx.col.users.findOne(
        { _id: uid },
        { session, projection: { vip: 1, wallet: 1 } },
      );
      if (!user) throw notFound('User');
      const now = this.ctx.clock.now();
      if (item.vipTierRequired > activeVipTier(user.vip, now))
        throw forbidden(`Requires VIP ${item.vipTierRequired}`);
      let diamonds = user.wallet.diamonds;
      if (item.priceDiamonds > 0) {
        diamonds = await this.ctx.services.wallet.debit(session, {
          uid,
          currency: 'diamonds',
          amount: item.priceDiamonds,
          reason: 'cosmetic_purchase',
          refId: String(item._id),
          meta: { type: item.type, name: item.name },
        });
      }
      const owned = await this.ctx.col.userCosmetics.findOne(
        { userId: uid, cosmeticId },
        { session },
      );
      const base = owned && owned.expiresAt > now ? owned.expiresAt : now;
      const expiresAt = addDays(base, item.durationDays);
      await this.ctx.col.userCosmetics.updateOne(
        { userId: uid, cosmeticId },
        {
          $set: { expiresAt, type: item.type },
          $setOnInsert: { userId: uid, cosmeticId, acquiredAt: now },
        },
        { upsert: true, session },
      );
      return { cosmeticId: String(cosmeticId), expiresAt: expiresAt.toISOString(), diamonds };
    });
    return { ...result, replayed };
  }

  async owned(uid: string) {
    const now = this.ctx.clock.now();
    const rows = await this.ctx.col.userCosmetics
      .find({ userId: uid, expiresAt: { $gt: now } })
      .toArray();
    const items = await this.ctx.col.cosmetics
      .find({ _id: { $in: rows.map((r) => r.cosmeticId) } })
      .toArray();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const user = await this.ctx.services.users.get(uid);
    return rows
      .map((r) => {
        const item = byId.get(String(r.cosmeticId));
        if (!item) return null;
        const equipped =
          (item.type === 'frame' && String(user.equipped.frameId) === String(item._id)) ||
          (item.type === 'entry_animation' &&
            String(user.equipped.entryAnimationId) === String(item._id));
        return { item: toCosmetic(item), expiresAt: r.expiresAt.toISOString(), equipped };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  async equip(
    uid: string,
    cosmeticId: ObjectId | null,
    type: 'frame' | 'entry_animation',
  ): Promise<void> {
    if (!cosmeticId) {
      const $set =
        type === 'frame'
          ? { 'equipped.frameId': null, 'equipped.frameUrl': null }
          : { 'equipped.entryAnimationId': null };
      await this.ctx.col.users.updateOne({ _id: uid }, { $set });
      return;
    }
    const now = this.ctx.clock.now();
    const owned = await this.ctx.col.userCosmetics.findOne({
      userId: uid,
      cosmeticId,
      expiresAt: { $gt: now },
    });
    if (!owned) throw forbidden('You do not own this item');
    const item = await this.ctx.col.cosmetics.findOne({ _id: cosmeticId });
    if (!item || item.type !== type) throw badRequest(`Item is not a ${type}`);
    const $set =
      type === 'frame'
        ? { 'equipped.frameId': item._id, 'equipped.frameUrl': item.assetUrl }
        : { 'equipped.entryAnimationId': item._id };
    await this.ctx.col.users.updateOne({ _id: uid }, { $set });
  }

  /** Clear equipped items whose ownership expired. Run by the hourly job. */
  async sweepExpired(): Promise<number> {
    const now = this.ctx.clock.now();
    const expired = await this.ctx.col.userCosmetics
      .find({ expiresAt: { $lte: now } }, { projection: { userId: 1, cosmeticId: 1 } })
      .limit(5000)
      .toArray();
    let cleared = 0;
    for (const e of expired) {
      const a = await this.ctx.col.users.updateOne(
        { _id: e.userId, 'equipped.frameId': e.cosmeticId },
        { $set: { 'equipped.frameId': null, 'equipped.frameUrl': null } },
      );
      const b = await this.ctx.col.users.updateOne(
        { _id: e.userId, 'equipped.entryAnimationId': e.cosmeticId },
        { $set: { 'equipped.entryAnimationId': null } },
      );
      cleared += a.modifiedCount + b.modifiedCount;
    }
    return cleared;
  }

  /** Resolve the entry animation a user shows when joining a room. */
  async entryAnimationFor(uid: string, session?: ClientSession): Promise<Cosmetic | null> {
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { equipped: 1 }, ...(session ? { session } : {}) },
    );
    const id = user?.equipped.entryAnimationId;
    if (!id) return null;
    const item = await this.ctx.col.cosmetics.findOne({ _id: id });
    return item ? toCosmetic(item) : null;
  }
}
