import { ObjectId, type ClientSession, type Filter, type UpdateFilter } from 'mongodb';
import { z } from 'zod';
import {
  ANIMATION_FORMATS,
  COSMETIC_TYPES,
  EQUIPPABLE_COSMETIC_TYPES,
  FRAME_FORMATS,
  MAX_GRANT_DAYS,
  MAX_VIP_TIER,
  MEDIA_EXTENSIONS,
  MEDIA_TYPES,
  vipTierLabel,
  type AdminCosmetic,
  type AdminUserCosmetic,
  type AnimationFormat,
  type Cosmetic,
  type CosmeticType,
  type EntryEffect,
  type EquippableCosmeticType,
  type OwnedCosmetic,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { CosmeticDoc, UserDoc, VipPackageDoc } from '../../db/schema.js';
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
  tier: z.number().int().min(1).max(MAX_VIP_TIER),
  name: z.string().trim().min(1).max(40),
  priceDiamonds: z.number().int().positive(),
  durationDays: z.number().int().min(1).max(366),
  perks: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  badgeUrl: z.url().nullable().default(null),
  frameUrl: z.url().nullable().default(null),
  frameFormat: z.enum(FRAME_FORMATS).default('none'),
  entryAnimationUrl: z.url().nullable().default(null),
  entryAnimationFormat: z.enum(ANIMATION_FORMATS).default('none'),
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
  durationDays: z.number().int().min(1).max(MAX_GRANT_DAYS),
  vipTierRequired: z.number().int().min(0).max(MAX_VIP_TIER).default(0),
  vipIncluded: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CosmeticInput = z.infer<typeof cosmeticInput>;

export const cosmeticListQuery = z.object({
  type: z.enum(COSMETIC_TYPES).optional(),
  /** Exact `vipTierRequired`; 0 lists items anyone may get. */
  vipTier: z.coerce.number().int().min(0).max(MAX_VIP_TIER).optional(),
  access: z.enum(['store', 'included']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  q: z.string().trim().max(40).optional(),
});

export const vipGrantInput = z
  .object({
    tier: z.number().int().min(0).max(MAX_VIP_TIER),
    days: z.number().int().min(1).max(MAX_GRANT_DAYS).optional(),
    /** `extend` adds to an unexpired membership of the same tier; `set` restarts from now. */
    mode: z.enum(['extend', 'set']).default('extend'),
  })
  .refine((v) => v.tier === 0 || v.days !== undefined, {
    message: 'Pick how many days',
    path: ['days'],
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
    vipIncluded: c.vipIncluded ?? false,
    active: c.active,
    sortOrder: c.sortOrder,
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isEquippable = (t: CosmeticType): t is EquippableCosmeticType =>
  (EQUIPPABLE_COSMETIC_TYPES as readonly string[]).includes(t);

/** The format a file plays as, from its URL's extension; null when the URL doesn't say. */
function formatOfUrl(url: string): AnimationFormat | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const type = MEDIA_EXTENSIONS[path.split('.').pop()?.toLowerCase() ?? ''];
  return type ? MEDIA_TYPES[type].format : null;
}

/** Rules a decoration must satisfy whole: checked on create and on the merged result of a patch. */
function checkCosmetic(c: Omit<CosmeticDoc, '_id' | 'createdAt'>): void {
  if (c.vipIncluded && c.vipTierRequired < 1)
    throw badRequest('Pick the VIP tier that includes this decoration');
  if (c.type === 'frame' && !(FRAME_FORMATS as readonly string[]).includes(c.animationFormat))
    throw badRequest('Avatar frames must be an image, SVGA or Lottie');
  const fromFile = formatOfUrl(c.assetUrl);
  if (fromFile && fromFile !== c.animationFormat)
    throw badRequest(
      `The asset is ${fromFile === 'none' ? 'an image' : fromFile}, not ${c.animationFormat}`,
    );
}

/** The `equipped.*` fields of each wearable slot. */
const SLOTS = {
  frame: { id: 'equipped.frameId', tier: 'equipped.frameVipTier' },
  entry_animation: { id: 'equipped.entryAnimationId', tier: 'equipped.entryAnimationVipTier' },
} as const;

/** Wear `item`; `vipTier` is 0 when owned, else the tier that entitles the wearer. */
function equipFields(item: CosmeticDoc, type: EquippableCosmeticType, vipTier: number) {
  return type === 'frame'
    ? {
        'equipped.frameId': item._id,
        'equipped.frameUrl': item.assetUrl,
        'equipped.frameFormat': item.animationFormat,
        'equipped.frameVipTier': vipTier,
      }
    : { 'equipped.entryAnimationId': item._id, 'equipped.entryAnimationVipTier': vipTier };
}

function unequipFields(type: EquippableCosmeticType) {
  return type === 'frame'
    ? {
        'equipped.frameId': null,
        'equipped.frameUrl': null,
        'equipped.frameFormat': 'none' as const,
        'equipped.frameVipTier': 0,
      }
    : { 'equipped.entryAnimationId': null, 'equipped.entryAnimationVipTier': 0 };
}

const sameId = (a: ObjectId | null | undefined, b: ObjectId) => !!a && a.equals(b);

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
    let saved: VipPackageDoc;
    let previousTier: number | null = null;
    try {
      if (!id) {
        saved = { _id: new ObjectId(), ...input };
        await this.ctx.col.vipPackages.insertOne(saved);
      } else {
        const before = await this.ctx.col.vipPackages.findOneAndUpdate(
          { _id: id },
          { $set: input },
          { returnDocument: 'before' },
        );
        if (!before) throw notFound('VIP package');
        previousTier = before.tier;
        saved = { ...before, ...input };
      }
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw conflict(`A package for VIP ${input.tier} already exists`);
      throw err;
    }
    // Members wear their tier's frame: re-sync everyone on the affected tiers.
    await this.syncTierFrame(saved.tier);
    if (previousTier !== null && previousTier !== saved.tier)
      await this.syncTierFrame(previousTier);
    return saved;
  }

  /** The VIP frame fields a holder of `tier` should carry, from that tier's package. */
  private async tierFrame(tier: number, session?: ClientSession) {
    const pkg = tier
      ? await this.ctx.col.vipPackages.findOne({ tier }, session ? { session } : {})
      : null;
    return {
      'equipped.vipFrameUrl': pkg?.frameUrl ?? null,
      'equipped.vipFrameFormat': pkg?.frameUrl ? pkg.frameFormat : 'none',
    } as const;
  }

  private async syncTierFrame(tier: number): Promise<void> {
    await this.ctx.col.users.updateMany({ 'vip.tier': tier }, { $set: await this.tierFrame(tier) });
  }

  /** Set a membership with its tier frame, and re-rank the user's live room if they're on air. */
  private async applyVip(
    session: ClientSession,
    uid: string,
    tier: number,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.ctx.col.users.updateOne(
      { _id: uid },
      { $set: { vip: { tier, expiresAt }, ...(await this.tierFrame(tier, session)) } },
      { session },
    );
    await this.ctx.col.liveRooms.updateOne(
      { hostId: uid, status: 'live' },
      { $set: { hostVipTier: tier } },
      { session },
    );
  }

  /**
   * Admin grant (or removal with tier 0) of VIP. `extend` adds `days` to an unexpired
   * membership of the same tier; otherwise, and with `set`, it runs `days` from now. Keyed
   * per admin so a retried request never stacks days twice.
   */
  async grantVip(uid: string, input: z.infer<typeof vipGrantInput>, adminUid: string, key: string) {
    const { result, replayed } = await once(
      this.ctx,
      'vip_grant',
      uid,
      `${adminUid}:${key}`,
      async (session) => {
        const user = await this.ctx.col.users.findOne(
          { _id: uid },
          { session, projection: { vip: 1 } },
        );
        if (!user) throw notFound('User');
        if (input.tier === 0) {
          await this.applyVip(session, uid, 0, null);
          return { tier: 0, expiresAt: null as string | null };
        }
        const now = this.ctx.clock.now();
        const extending = input.mode === 'extend' && activeVipTier(user.vip, now) === input.tier;
        // A legacy membership with no expiry stays open-ended when extended.
        const expiresAt =
          extending && !user.vip.expiresAt
            ? null
            : addDays(extending ? user.vip.expiresAt! : now, input.days!);
        await this.applyVip(session, uid, input.tier, expiresAt);
        return { tier: input.tier, expiresAt: expiresAt?.toISOString() ?? null };
      },
    );
    return { ...result, replayed };
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
      await this.applyVip(session, uid, pkg.tier, expiresAt);
      return { tier: pkg.tier, expiresAt: expiresAt.toISOString(), diamonds };
    });
    return { ...result, replayed };
  }

  // ── Cosmetics catalog ──────────────────────────────────────────────────────────

  async cosmetics(type: CosmeticType | undefined, includeInactive = false): Promise<Cosmetic[]> {
    const docs = await this.ctx.col.cosmetics
      .find({ ...(type ? { type } : {}), ...(includeInactive ? {} : { active: true }) })
      .sort({ type: 1, sortOrder: 1 })
      .toArray();
    return docs.map(toCosmetic);
  }

  /** The admin catalog: paged and filtered, with how many users hold each item now. */
  async adminCosmetics(
    q: z.infer<typeof cosmeticListQuery>,
    page: number,
    pageSize: number,
  ): Promise<{ items: AdminCosmetic[]; total: number; page: number; pageSize: number }> {
    const filter: Filter<CosmeticDoc> = {};
    if (q.type) filter.type = q.type;
    if (q.vipTier !== undefined) filter.vipTierRequired = q.vipTier;
    if (q.access === 'included') filter.vipIncluded = true;
    if (q.access === 'store') filter.vipIncluded = { $ne: true };
    if (q.status) filter.active = q.status === 'active';
    if (q.q) filter.name = { $regex: escapeRegex(q.q), $options: 'i' };
    const [docs, total] = await Promise.all([
      this.ctx.col.cosmetics
        .find(filter)
        .sort({ type: 1, sortOrder: 1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.cosmetics.countDocuments(filter),
    ]);
    const counts = docs.length
      ? await this.ctx.col.userCosmetics
          .aggregate<{ _id: ObjectId; n: number }>([
            {
              $match: {
                cosmeticId: { $in: docs.map((d) => d._id) },
                expiresAt: { $gt: this.ctx.clock.now() },
              },
            },
            { $group: { _id: '$cosmeticId', n: { $sum: 1 } } },
          ])
          .toArray()
      : [];
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    return {
      items: docs.map((d) => ({
        ...toCosmetic(d),
        ownerCount: byId.get(String(d._id)) ?? 0,
        createdAt: d.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async createCosmetic(input: CosmeticInput): Promise<Cosmetic> {
    const [item] = await this.createCosmetics([input]);
    return item!;
  }

  /** Insert many decorations at once (bulk upload). All are validated before any is written. */
  async createCosmetics(inputs: CosmeticInput[]): Promise<Cosmetic[]> {
    inputs.forEach((input, i) => {
      try {
        checkCosmetic(input);
      } catch (err) {
        if (inputs.length > 1 && err instanceof Error)
          err.message = `Item ${i + 1}: ${err.message}`;
        throw err;
      }
    });
    const now = this.ctx.clock.now();
    const docs: CosmeticDoc[] = inputs.map((input) => ({
      _id: new ObjectId(),
      ...input,
      createdAt: now,
    }));
    await this.ctx.col.cosmetics.insertMany(docs);
    return docs.map(toCosmetic);
  }

  /** Apply the fields sent; wearers pick up the new asset and VIP terms at once. */
  async updateCosmetic(id: ObjectId, patch: Partial<CosmeticInput>): Promise<Cosmetic> {
    const before = await this.ctx.col.cosmetics.findOne({ _id: id });
    if (!before) throw notFound('Decoration');
    if (patch.type && patch.type !== before.type)
      throw badRequest("A decoration's type can't change; create a new one instead");
    checkCosmetic({ ...before, ...patch });
    const after = await this.ctx.col.cosmetics.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: 'after' },
    );
    if (!after) throw notFound('Decoration');
    await this.syncEquipped(after);
    return toCosmetic(after);
  }

  /**
   * Delete a decoration nobody holds or wears (a mistaken upload). Anything in use is
   * deactivated instead, so purchases and grants keep pointing at a real item.
   */
  async deleteCosmetic(id: ObjectId): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      const item = await this.ctx.col.cosmetics.findOne({ _id: id }, { session });
      if (!item) throw notFound('Decoration');
      const [owners, wearers] = await Promise.all([
        this.ctx.col.userCosmetics.countDocuments(
          { cosmeticId: id, expiresAt: { $gt: this.ctx.clock.now() } },
          { session },
        ),
        this.ctx.col.users.countDocuments(
          { $or: [{ 'equipped.frameId': id }, { 'equipped.entryAnimationId': id }] },
          { session },
        ),
      ]);
      const inUse = Math.max(owners, wearers);
      if (inUse)
        throw conflict(
          `Held or worn by ${inUse} user${inUse === 1 ? '' : 's'}. Deactivate it instead.`,
        );
      await this.ctx.col.userCosmetics.deleteMany({ cosmeticId: id }, { session });
      await this.ctx.col.cosmetics.deleteOne({ _id: id }, { session });
    });
  }

  /**
   * After an edit: everyone wearing the item gets its current asset, and those wearing it
   * through VIP follow its current terms (or take it off once it is no longer included).
   */
  private async syncEquipped(item: CosmeticDoc): Promise<void> {
    if (!isEquippable(item.type)) return;
    const slot = SLOTS[item.type];
    if (item.type === 'frame')
      await this.ctx.col.users.updateMany(
        { 'equipped.frameId': item._id },
        {
          $set: {
            'equipped.frameUrl': item.assetUrl,
            'equipped.frameFormat': item.animationFormat,
          },
        },
      );
    const viaVip = { [slot.id]: item._id, [slot.tier]: { $gt: 0 } } as Filter<UserDoc>;
    const $set =
      item.vipIncluded && item.active
        ? { [slot.tier]: item.vipTierRequired }
        : unequipFields(item.type);
    await this.ctx.col.users.updateMany(viaVip, { $set } as UpdateFilter<UserDoc>);
  }

  // ── Ownership & wearing ─────────────────────────────────────────────────────────

  /** Add `days` of ownership, extending an unexpired hold. Returns the new expiry. */
  private async addOwnership(
    session: ClientSession,
    uid: string,
    item: CosmeticDoc,
    days: number,
    source: 'purchase' | 'admin',
    grantedBy: string | null,
  ): Promise<Date> {
    const now = this.ctx.clock.now();
    const owned = await this.ctx.col.userCosmetics.findOne(
      { userId: uid, cosmeticId: item._id },
      { session },
    );
    const holding = !!owned && owned.expiresAt > now;
    const expiresAt = addDays(holding ? owned.expiresAt : now, days);
    await this.ctx.col.userCosmetics.updateOne(
      { userId: uid, cosmeticId: item._id },
      {
        $set: {
          expiresAt,
          type: item.type,
          source,
          grantedBy,
          ...(holding ? {} : { acquiredAt: now }),
        },
        $setOnInsert: { userId: uid, cosmeticId: item._id },
      },
      { upsert: true, session },
    );
    return expiresAt;
  }

  async purchaseCosmetic(uid: string, cosmeticId: ObjectId, key: string) {
    const item = await this.ctx.col.cosmetics.findOne({ _id: cosmeticId, active: true });
    if (!item) throw notFound('Item');
    if (item.vipIncluded)
      throw badRequest(
        `Included with ${vipTierLabel(item.vipTierRequired) ?? `VIP ${item.vipTierRequired}`}`,
      );
    const { result, replayed } = await once(this.ctx, 'cosmetic', uid, key, async (session) => {
      const user = await this.ctx.col.users.findOne(
        { _id: uid },
        { session, projection: { vip: 1, wallet: 1 } },
      );
      if (!user) throw notFound('User');
      if (item.vipTierRequired > activeVipTier(user.vip, this.ctx.clock.now()))
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
      const expiresAt = await this.addOwnership(
        session,
        uid,
        item,
        item.durationDays,
        'purchase',
        null,
      );
      return { cosmeticId: String(cosmeticId), expiresAt: expiresAt.toISOString(), diamonds };
    });
    return { ...result, replayed };
  }

  /**
   * Admin grant of a decoration for `days` (default: the item's duration), extending any
   * unexpired hold. Frames and entrance effects are worn at once. Inactive items may be
   * granted: that is how event-only decorations reach users. Keyed per admin.
   */
  async grantCosmetic(
    uid: string,
    cosmeticId: ObjectId,
    days: number | undefined,
    adminUid: string,
    key: string,
  ) {
    const item = await this.ctx.col.cosmetics.findOne({ _id: cosmeticId });
    if (!item) throw notFound('Decoration');
    const grantDays = days ?? item.durationDays;
    const { result, replayed } = await once(
      this.ctx,
      'cosmetic_grant',
      uid,
      `${adminUid}:${key}`,
      async (session) => {
        const user = await this.ctx.col.users.findOne(
          { _id: uid },
          { session, projection: { _id: 1 } },
        );
        if (!user) throw notFound('User');
        const expiresAt = await this.addOwnership(session, uid, item, grantDays, 'admin', adminUid);
        const equipped = isEquippable(item.type);
        if (equipped)
          await this.ctx.col.users.updateOne(
            { _id: uid },
            { $set: equipFields(item, item.type as EquippableCosmeticType, 0) },
            { session },
          );
        return {
          cosmeticId: String(item._id),
          name: item.name,
          type: item.type,
          days: grantDays,
          expiresAt: expiresAt.toISOString(),
          equipped,
        };
      },
    );
    return { ...result, replayed };
  }

  /** Take back an owned decoration; it comes off unless the user wears it through VIP. */
  async revokeCosmetic(uid: string, cosmeticId: ObjectId): Promise<void> {
    await this.ctx.db.withTransaction(async (session) => {
      const removed = await this.ctx.col.userCosmetics.findOneAndDelete(
        { userId: uid, cosmeticId },
        { session },
      );
      if (!removed) throw notFound('This user does not own that decoration');
      if (!isEquippable(removed.type)) return;
      const slot = SLOTS[removed.type];
      await this.ctx.col.users.updateOne(
        { _id: uid, [slot.id]: cosmeticId, [slot.tier]: { $not: { $gt: 0 } } } as Filter<UserDoc>,
        { $set: unequipFields(removed.type) } as UpdateFilter<UserDoc>,
        { session },
      );
    });
  }

  /** What a user may wear: owned items, then items their VIP tier includes. */
  async owned(uid: string): Promise<OwnedCosmetic[]> {
    return (await this.wardrobe(uid)).map(({ item, expiresAt, equipped, source }) => ({
      item,
      expiresAt,
      equipped,
      source,
    }));
  }

  /** {@link owned} with acquisition details, for the admin's view of a user. */
  async wardrobe(uid: string): Promise<AdminUserCosmetic[]> {
    const now = this.ctx.clock.now();
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { vip: 1, equipped: 1 } },
    );
    if (!user) throw notFound('User');
    const tier = activeVipTier(user.vip, now);
    const [rows, included] = await Promise.all([
      this.ctx.col.userCosmetics
        .find({ userId: uid, expiresAt: { $gt: now } })
        .sort({ acquiredAt: -1 })
        .toArray(),
      tier > 0
        ? this.ctx.col.cosmetics
            .find({ vipIncluded: true, active: true, vipTierRequired: { $gte: 1, $lte: tier } })
            .sort({ type: 1, sortOrder: 1, _id: -1 })
            .toArray()
        : [],
    ]);
    const items = rows.length
      ? await this.ctx.col.cosmetics.find({ _id: { $in: rows.map((r) => r.cosmeticId) } }).toArray()
      : [];
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const isWorn = (item: CosmeticDoc) =>
      item.type === 'frame'
        ? sameId(user.equipped.frameId, item._id)
        : item.type === 'entry_animation' && sameId(user.equipped.entryAnimationId, item._id);

    const out: AdminUserCosmetic[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const item = byId.get(String(r.cosmeticId));
      if (!item) continue;
      seen.add(String(item._id));
      out.push({
        item: toCosmetic(item),
        expiresAt: r.expiresAt.toISOString(),
        equipped: isWorn(item),
        source: 'owned',
        acquiredAt: r.acquiredAt.toISOString(),
        grantSource: r.source ?? null,
        grantedBy: r.grantedBy ?? null,
      });
    }
    for (const item of included) {
      if (seen.has(String(item._id))) continue;
      out.push({
        item: toCosmetic(item),
        expiresAt: user.vip.expiresAt?.toISOString() ?? null,
        equipped: isWorn(item),
        source: 'vip',
        acquiredAt: null,
        grantSource: null,
        grantedBy: null,
      });
    }
    return out;
  }

  /** Wear an item the user owns, or one their active VIP tier includes; null takes it off. */
  async equip(
    uid: string,
    cosmeticId: ObjectId | null,
    type: EquippableCosmeticType,
  ): Promise<void> {
    if (!cosmeticId) {
      await this.ctx.col.users.updateOne({ _id: uid }, { $set: unequipFields(type) });
      return;
    }
    const now = this.ctx.clock.now();
    const [owned, item, user] = await Promise.all([
      this.ctx.col.userCosmetics.findOne({ userId: uid, cosmeticId, expiresAt: { $gt: now } }),
      this.ctx.col.cosmetics.findOne({ _id: cosmeticId }),
      this.ctx.col.users.findOne({ _id: uid }, { projection: { vip: 1 } }),
    ]);
    if (!user) throw notFound('User');
    const included =
      !!item?.vipIncluded && item.active && item.vipTierRequired <= activeVipTier(user.vip, now);
    if (!owned && !included) throw forbidden('You do not own this item');
    if (!item || item.type !== type) throw badRequest(`Item is not a ${type}`);
    await this.ctx.col.users.updateOne(
      { _id: uid },
      { $set: equipFields(item, type, owned ? 0 : item.vipTierRequired) },
    );
  }

  /**
   * Take off what nobody may wear any more: items whose ownership expired, and items worn
   * through a VIP tier the user no longer holds. Reads already ignore both; this keeps the
   * stored state honest. Run by the hourly job.
   */
  async sweepExpired(): Promise<number> {
    const now = this.ctx.clock.now();
    const expired = await this.ctx.col.userCosmetics
      .find({ expiresAt: { $lte: now } }, { projection: { userId: 1, cosmeticId: 1 } })
      .limit(5000)
      .toArray();
    let cleared = 0;
    for (const e of expired) {
      for (const type of EQUIPPABLE_COSMETIC_TYPES) {
        const slot = SLOTS[type];
        // Worn through VIP is still fine while the tier lasts; that is checked below.
        const res = await this.ctx.col.users.updateOne(
          {
            _id: e.userId,
            [slot.id]: e.cosmeticId,
            [slot.tier]: { $not: { $gt: 0 } },
          } as Filter<UserDoc>,
          { $set: unequipFields(type) } as UpdateFilter<UserDoc>,
        );
        cleared += res.modifiedCount;
      }
    }
    for (const type of EQUIPPABLE_COSMETIC_TYPES) {
      const slot = SLOTS[type];
      const res = await this.ctx.col.users.updateMany(
        {
          [slot.tier]: { $gt: 0 },
          $or: [
            { 'vip.expiresAt': { $lte: now } },
            { $expr: { $lt: ['$vip.tier', `$${slot.tier}`] } },
          ],
        } as Filter<UserDoc>,
        { $set: unequipFields(type) } as UpdateFilter<UserDoc>,
      );
      cleared += res.modifiedCount;
    }
    return cleared;
  }

  /**
   * The entrance effect played when `uid` joins a room: their equipped entry animation (one
   * worn through VIP only while that tier is held), else the effect of their VIP tier, else none.
   */
  async entryEffectFor(uid: string, vipTier: number): Promise<EntryEffect | null> {
    const user = await this.ctx.col.users.findOne({ _id: uid }, { projection: { equipped: 1 } });
    const e = user?.equipped;
    if (e?.entryAnimationId && (e.entryAnimationVipTier ?? 0) <= vipTier) {
      const item = await this.ctx.col.cosmetics.findOne(
        { _id: e.entryAnimationId },
        { projection: { assetUrl: 1, animationFormat: 1 } },
      );
      if (item) return { url: item.assetUrl, format: item.animationFormat };
    }
    if (vipTier <= 0) return null;
    const pkg = await this.ctx.col.vipPackages.findOne(
      { tier: vipTier },
      { projection: { entryAnimationUrl: 1, entryAnimationFormat: 1 } },
    );
    return pkg?.entryAnimationUrl
      ? { url: pkg.entryAnimationUrl, format: pkg.entryAnimationFormat ?? 'none' }
      : null;
  }
}
