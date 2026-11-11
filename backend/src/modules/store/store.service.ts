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
  STORE_COSMETIC_TYPES,
  vipTierLabel,
  type AdminCosmetic,
  type AdminUserCosmetic,
  type AnimationFormat,
  type Cosmetic,
  type CosmeticType,
  type EntryEffect,
  type EquippableCosmeticType,
  type OwnedCosmetic,
  type StoreCosmetic,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { CosmeticDoc, UserDoc } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { once } from '../../lib/idempotency.js';
import { addDays } from '../../lib/time.js';
import { activeVipTier, SLOT_PREFIX, slotWearable } from '../users/users.presenter.js';

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
    throw badRequest('Pick the tier that includes this decoration');
  if (c.type === 'frame' && !(FRAME_FORMATS as readonly string[]).includes(c.animationFormat))
    throw badRequest('Avatar frames must be an image, SVGA or Lottie');
  const fromFile = formatOfUrl(c.assetUrl);
  if (fromFile && fromFile !== c.animationFormat)
    throw badRequest(
      `The asset is ${fromFile === 'none' ? 'an image' : fromFile}, not ${c.animationFormat}`,
    );
}

/** The `equipped.*` fields of each wearable slot. */
function slotOf(type: EquippableCosmeticType) {
  const p = `equipped.${SLOT_PREFIX[type]}`;
  return { id: `${p}Id`, tier: `${p}VipTier`, expires: `${p}ExpiresAt` } as const;
}
const SLOTS = Object.fromEntries(EQUIPPABLE_COSMETIC_TYPES.map((t) => [t, slotOf(t)])) as {
  [T in EquippableCosmeticType]: ReturnType<typeof slotOf>;
};

/**
 * Wear `item`. `vipTier` is 0 when owned, else the tier that entitles the wearer;
 * `expiresAt` is the ownership's expiry (null when worn through a tier).
 */
function equipFields(
  item: CosmeticDoc,
  type: EquippableCosmeticType,
  vipTier: number,
  expiresAt: Date | null,
): Record<string, unknown> {
  const slot = SLOTS[type];
  const out: Record<string, unknown> = {
    [slot.id]: item._id,
    [slot.tier]: vipTier,
    [slot.expires]: vipTier > 0 ? null : expiresAt,
  };
  if (type === 'frame') {
    out['equipped.frameUrl'] = item.assetUrl;
    out['equipped.frameFormat'] = item.animationFormat;
  }
  if (type === 'room_background') out['equipped.roomBackgroundUrl'] = item.assetUrl;
  return out;
}

function unequipFields(type: EquippableCosmeticType): Record<string, unknown> {
  const slot = SLOTS[type];
  const out: Record<string, unknown> = { [slot.id]: null, [slot.tier]: 0, [slot.expires]: null };
  if (type === 'frame') {
    out['equipped.frameUrl'] = null;
    out['equipped.frameFormat'] = 'none';
  }
  if (type === 'room_background') out['equipped.roomBackgroundUrl'] = null;
  return out;
}

/** Users the hourly sweep handles per batch. Cleared rows stop matching, so it always progresses. */
const SWEEP_BATCH = 500;
/** Upper bound on one sweep's batches, so a backlog is spread over runs instead of one long job. */
const SWEEP_MAX_BATCHES = 200;

const storeType = (t: CosmeticType) => (STORE_COSMETIC_TYPES as readonly string[]).includes(t);

const sameId = (a: ObjectId | null | undefined, b: ObjectId) => !!a && a.equals(b);

/** Whether `item` is the one in its slot of `equipped`. */
function isWornBy(equipped: UserDoc['equipped'] | undefined, item: CosmeticDoc): boolean {
  if (!equipped || !isEquippable(item.type)) return false;
  const id = (equipped as unknown as Record<string, ObjectId | null | undefined>)[
    `${SLOT_PREFIX[item.type]}Id`
  ];
  return sameId(id, item._id);
}

/** Cosmetics (avatar frames, entry animations, room backgrounds, bubbles). Tier packages live in `TierPackagesService`. */
export class StoreService {
  constructor(private readonly ctx: Ctx) {}

  // ── Cosmetics catalog ──────────────────────────────────────────────────────────

  async cosmetics(type: CosmeticType | undefined, includeInactive = false): Promise<Cosmetic[]> {
    const docs = await this.ctx.col.cosmetics
      .find({ ...(type ? { type } : {}), ...(includeInactive ? {} : { active: true }) })
      .sort({ type: 1, sortOrder: 1 })
      .toArray();
    return docs.map(toCosmetic);
  }

  /**
   * The app's store: active items of the types the app sells, each with the caller's own
   * state (owned until when, worn), so a tile can say Owned / Equipped instead of Buy.
   */
  async storeItems(uid: string, type: CosmeticType | undefined): Promise<StoreCosmetic[]> {
    if (type && !storeType(type)) return [];
    const now = this.ctx.clock.now();
    const [docs, user] = await Promise.all([
      this.ctx.col.cosmetics
        .find({ active: true, type: type ? type : { $in: [...STORE_COSMETIC_TYPES] } })
        .sort({ type: 1, sortOrder: 1 })
        .toArray(),
      this.ctx.col.users.findOne({ _id: uid }, { projection: { equipped: 1 } }),
    ]);
    const owned = docs.length
      ? await this.ctx.col.userCosmetics
          .find(
            { userId: uid, cosmeticId: { $in: docs.map((d) => d._id) }, expiresAt: { $gt: now } },
            { projection: { cosmeticId: 1, expiresAt: 1 } },
          )
          .toArray()
      : [];
    const until = new Map(owned.map((o) => [String(o.cosmeticId), o.expiresAt]));
    return docs.map((d) => {
      const ownedUntil = until.get(String(d._id)) ?? null;
      return {
        ...toCosmetic(d),
        owned: Boolean(ownedUntil),
        ownedUntil: ownedUntil?.toISOString() ?? null,
        equipped: isWornBy(user?.equipped, d),
      };
    });
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
        if (!storeType(input.type))
          throw badRequest(`New ${input.type.replace('_', ' ')} items can't be created yet`);
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
          { $or: EQUIPPABLE_COSMETIC_TYPES.map((t) => ({ [SLOTS[t].id]: id })) } as Filter<UserDoc>,
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
    // Who wears it now, before the writes below may take it off some of them.
    const wearers = await this.ctx.col.users.distinct('_id', {
      [slot.id]: item._id,
    } as Filter<UserDoc>);
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
    if (item.type === 'room_background')
      await this.ctx.col.users.updateMany(
        { 'equipped.roomBackgroundId': item._id },
        { $set: { 'equipped.roomBackgroundUrl': item.assetUrl } },
      );
    const viaVip = { [slot.id]: item._id, [slot.tier]: { $gt: 0 } } as Filter<UserDoc>;
    const $set =
      item.vipIncluded && item.active
        ? { [slot.tier]: item.vipTierRequired }
        : unequipFields(item.type);
    await this.ctx.col.users.updateMany(viaVip, { $set } as UpdateFilter<UserDoc>);
    await this.refreshWearers(wearers);
  }

  /**
   * After what some users wear changed: re-mint their live identity (frame in LiveKit
   * metadata, directory card, room background) where they are live or watching. Never fails
   * the change that caused it.
   */
  private async refreshWearers(uids: string[]): Promise<void> {
    if (!uids.length) return;
    await this.ctx.services.live
      .refreshIdentities(uids)
      .catch((err: unknown) => this.ctx.log.warn({ err }, 'live identity refresh failed'));
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
    // Extending an item that is worn: the slot carries the new expiry, or it would lapse at
    // the old one.
    if (isEquippable(item.type)) {
      const slot = SLOTS[item.type];
      await this.ctx.col.users.updateOne(
        { _id: uid, [slot.id]: item._id, [slot.tier]: { $not: { $gt: 0 } } } as Filter<UserDoc>,
        { $set: { [slot.expires]: expiresAt } } as UpdateFilter<UserDoc>,
        { session },
      );
    }
    return expiresAt;
  }

  async purchaseCosmetic(uid: string, cosmeticId: ObjectId, key: string) {
    const item = await this.ctx.col.cosmetics.findOne({ _id: cosmeticId, active: true });
    if (!item || !storeType(item.type)) throw notFound('Item');
    if (item.vipIncluded)
      throw badRequest(
        `Included with ${vipTierLabel(item.vipTierRequired) ?? `tier ${item.vipTierRequired}`}`,
      );
    const { result, replayed } = await once(this.ctx, 'cosmetic', uid, key, async (session) => {
      const user = await this.ctx.col.users.findOne(
        { _id: uid },
        { session, projection: { vip: 1, wallet: 1 } },
      );
      if (!user) throw notFound('User');
      if (item.vipTierRequired > activeVipTier(user.vip, this.ctx.clock.now()))
        throw forbidden(
          `Requires ${vipTierLabel(item.vipTierRequired) ?? `tier ${item.vipTierRequired}`}`,
        );
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
            {
              $set: equipFields(item, item.type as EquippableCosmeticType, 0, expiresAt),
            } as UpdateFilter<UserDoc>,
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
    if (result.equipped && !replayed) await this.refreshWearers([uid]);
    return { ...result, replayed };
  }

  /** Take back an owned decoration; it comes off unless the user wears it through VIP. */
  async revokeCosmetic(uid: string, cosmeticId: ObjectId): Promise<void> {
    const takenOff = await this.ctx.db.withTransaction(async (session) => {
      const removed = await this.ctx.col.userCosmetics.findOneAndDelete(
        { userId: uid, cosmeticId },
        { session },
      );
      if (!removed) throw notFound('This user does not own that decoration');
      if (!isEquippable(removed.type)) return false;
      const slot = SLOTS[removed.type];
      const res = await this.ctx.col.users.updateOne(
        { _id: uid, [slot.id]: cosmeticId, [slot.tier]: { $not: { $gt: 0 } } } as Filter<UserDoc>,
        { $set: unequipFields(removed.type) } as UpdateFilter<UserDoc>,
        { session },
      );
      return res.modifiedCount > 0;
    });
    if (takenOff) await this.refreshWearers([uid]);
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
  async wardrobe(uid: string, opts: { allTypes?: boolean } = {}): Promise<AdminUserCosmetic[]> {
    const now = this.ctx.clock.now();
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { vip: 1, equipped: 1 } },
    );
    if (!user) throw notFound('User');
    const tier = activeVipTier(user.vip, now);
    // The app lists only what it can show; the admin sees everything the user holds.
    const typeFilter = opts.allTypes ? {} : { type: { $in: [...STORE_COSMETIC_TYPES] } };
    const [rows, included] = await Promise.all([
      this.ctx.col.userCosmetics
        .find({ userId: uid, expiresAt: { $gt: now }, ...typeFilter })
        .sort({ acquiredAt: -1 })
        .toArray(),
      tier > 0
        ? this.ctx.col.cosmetics
            .find({
              vipIncluded: true,
              active: true,
              vipTierRequired: { $gte: 1, $lte: tier },
              ...typeFilter,
            })
            .sort({ type: 1, sortOrder: 1, _id: -1 })
            .toArray()
        : [],
    ]);
    const items = rows.length
      ? await this.ctx.col.cosmetics.find({ _id: { $in: rows.map((r) => r.cosmeticId) } }).toArray()
      : [];
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const isWorn = (item: CosmeticDoc) => isWornBy(user.equipped, item);

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

  /**
   * Wear an item the user owns, or one their active VIP tier includes; null takes it off.
   * The ownership read and the slot write share a transaction, so a concurrent revoke or sweep
   * can't leave an item worn that is no longer held. Live rooms pick the change up at once.
   */
  async equip(
    uid: string,
    cosmeticId: ObjectId | null,
    type: EquippableCosmeticType,
  ): Promise<void> {
    if (!cosmeticId) {
      const res = await this.ctx.col.users.updateOne(
        { _id: uid, [SLOTS[type].id]: { $ne: null } } as Filter<UserDoc>,
        { $set: unequipFields(type) } as UpdateFilter<UserDoc>,
      );
      if (res.modifiedCount) await this.refreshWearers([uid]);
      return;
    }
    const now = this.ctx.clock.now();
    await this.ctx.db.withTransaction(async (session) => {
      const [owned, item, user] = await Promise.all([
        this.ctx.col.userCosmetics.findOne(
          { userId: uid, cosmeticId, expiresAt: { $gt: now } },
          { session },
        ),
        this.ctx.col.cosmetics.findOne({ _id: cosmeticId }, { session }),
        this.ctx.col.users.findOne({ _id: uid }, { session, projection: { vip: 1 } }),
      ]);
      if (!user) throw notFound('User');
      if (!item) throw notFound('Item');
      if (item.type !== type) throw badRequest(`Item is not a ${type}`);
      const included =
        !!item.vipIncluded && item.active && item.vipTierRequired <= activeVipTier(user.vip, now);
      if (!owned && !included) throw forbidden('You do not own this item');
      await this.ctx.col.users.updateOne(
        { _id: uid },
        {
          $set: equipFields(item, type, owned ? 0 : item.vipTierRequired, owned?.expiresAt ?? null),
        } as UpdateFilter<UserDoc>,
        { session },
      );
    });
    await this.refreshWearers([uid]);
  }

  /**
   * Take off what nobody may wear any more: items whose ownership expired, and items worn
   * through a VIP tier the user no longer holds. Reads already ignore both
   * (`slotWearable`); this keeps the stored state honest and live rooms current. Run by the
   * hourly job.
   *
   * It queries the users' own slots (`*ExpiresAt`, `*VipTier`), never the ownership rows,
   * which are kept after they expire: a scan over those re-read the same oldest rows forever
   * once there were more than one batch of them. Cleared users stop matching, so every batch
   * makes progress.
   */
  async sweepExpired(): Promise<number> {
    const now = this.ctx.clock.now();
    const touched = new Set<string>();
    let cleared = 0;
    for (const type of EQUIPPABLE_COSMETIC_TYPES) {
      const slot = SLOTS[type];
      const lapsed: Filter<UserDoc>[] = [
        // Owned and expired (slots worn through a tier carry no expiry).
        { [slot.expires]: { $lte: now } } as Filter<UserDoc>,
        // Worn through a tier that ended or is now too low.
        {
          [slot.tier]: { $gt: 0 },
          $or: [
            { 'vip.expiresAt': { $lte: now } },
            { $expr: { $lt: [{ $ifNull: ['$vip.tier', 0] }, `$${slot.tier}`] } },
          ],
        } as Filter<UserDoc>,
      ];
      for (const filter of lapsed) {
        for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
          const ids = await this.ctx.col.users
            .find(filter, { projection: { _id: 1 } })
            .limit(SWEEP_BATCH)
            .map((u) => u._id)
            .toArray();
          if (!ids.length) break;
          const res = await this.ctx.col.users.updateMany(
            { $and: [{ _id: { $in: ids } }, filter] } as Filter<UserDoc>,
            { $set: unequipFields(type) } as UpdateFilter<UserDoc>,
          );
          cleared += res.modifiedCount;
          ids.forEach((id) => touched.add(id));
          if (ids.length < SWEEP_BATCH) break;
        }
      }
    }
    await this.refreshWearers([...touched]);
    return cleared;
  }

  /**
   * The entrance effect played when `uid` joins a room: their equipped entry animation while
   * it is wearable (worn through a tier only while that tier is held, owned only until the
   * ownership expires), else none.
   */
  async entryEffectFor(uid: string, vipTier: number): Promise<EntryEffect | null> {
    const user = await this.ctx.col.users.findOne({ _id: uid }, { projection: { equipped: 1 } });
    const e = user?.equipped;
    if (!e?.entryAnimationId || !slotWearable(e, 'entry_animation', vipTier, this.ctx.clock.now()))
      return null;
    const item = await this.ctx.col.cosmetics.findOne(
      { _id: e.entryAnimationId },
      { projection: { assetUrl: 1, animationFormat: 1 } },
    );
    return item ? { url: item.assetUrl, format: item.animationFormat } : null;
  }
}
