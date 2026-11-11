import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { CosmeticInput } from '../src/modules/store/store.service.js';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
const DAY = 86_400;

const item = (o: Partial<CosmeticInput> = {}) =>
  h.ctx.services.store.createCosmetic({
    type: 'frame',
    name: 'Gilded',
    assetUrl: 'https://cdn.test/admin/cosmetics/f.svga',
    previewUrl: null,
    animationFormat: 'svga',
    priceDiamonds: 100,
    durationDays: 7,
    vipTierRequired: 0,
    vipIncluded: false,
    active: true,
    sortOrder: 0,
    ...o,
  });

const buy = (uid: string, id: string) =>
  h.api
    .post(`/v1/store/items/${id}/purchase`)
    .set(h.as(uid))
    .set('Idempotency-Key', key())
    .expect(200);
const equip = (uid: string, itemId: string | null, type: string) =>
  h.api.post('/v1/store/equip').set(h.as(uid)).send({ itemId, type });
const brief = async (uid: string) => (await h.ctx.services.users.briefs([uid])).get(uid)!;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe('expiry is checked on read', () => {
  it('an expired frame and entrance stop showing before the sweep runs', async () => {
    await h.user('lapse', { wallet: { diamonds: 10_000 } });
    const frame = await item();
    const entrance = await item({
      type: 'entry_animation',
      name: 'Comet',
      assetUrl: 'https://cdn.test/admin/cosmetics/comet.svga',
    });
    await buy('lapse', frame.id);
    await buy('lapse', entrance.id);
    expect((await equip('lapse', frame.id, 'frame')).status).toBe(204);
    expect((await equip('lapse', entrance.id, 'entry_animation')).status).toBe(204);
    expect((await brief('lapse')).frameUrl).toBe(frame.assetUrl);
    expect(await h.ctx.services.store.entryEffectFor('lapse', 0)).not.toBeNull();

    h.clock.advance(7 * DAY + 1);
    // No sweep yet: reads already drop both.
    expect((await brief('lapse')).frameUrl).toBeNull();
    expect(await h.ctx.services.store.entryEffectFor('lapse', 0)).toBeNull();
    const mine = await h.api.get('/v1/store/mine').set(h.as('lapse'));
    expect(mine.body.items).toHaveLength(0);

    await h.ctx.services.store.sweepExpired();
    const doc = (await h.ctx.col.users.findOne({ _id: 'lapse' }))!;
    expect(doc.equipped.frameId).toBeNull();
    expect(doc.equipped.entryAnimationId).toBeNull();
  });

  it('buying again extends what is worn, so it lasts to the new expiry', async () => {
    await h.user('extend', { wallet: { diamonds: 10_000 } });
    const frame = await item({ name: 'Extendable' });
    await buy('extend', frame.id);
    await equip('extend', frame.id, 'frame').expect(204);
    await buy('extend', frame.id);
    h.clock.advance(10 * DAY);
    expect((await brief('extend')).frameUrl).toBe(frame.assetUrl);
    h.clock.advance(5 * DAY);
    expect((await brief('extend')).frameUrl).toBeNull();
  });

  it('the sweep clears every lapsed slot, however many there are', async () => {
    const frame = await item({ name: 'Mass' });
    const past = new Date(h.clock.now().getTime() - 1000);
    const base = (await h.ctx.col.users.findOne({ _id: 'lapse' }))!;
    const docs = Array.from({ length: 1200 }, (_, i) => ({
      ...base,
      _id: `mass-${i}`,
      shortId: String(90_000_000 + i),
      equipped: {
        ...base.equipped,
        frameId: new ObjectId(frame.id),
        frameUrl: frame.assetUrl,
        frameFormat: 'svga' as const,
        frameVipTier: 0,
        frameExpiresAt: past,
      },
    }));
    await h.ctx.col.users.insertMany(docs);
    const cleared = await h.ctx.services.store.sweepExpired();
    expect(cleared).toBeGreaterThanOrEqual(1200);
    expect(
      await h.ctx.col.users.countDocuments({ 'equipped.frameExpiresAt': { $lte: h.clock.now() } }),
    ).toBe(0);
  });
});

describe('equip rules', () => {
  it('unequips with null and refuses the wrong slot', async () => {
    await h.user('picky', { wallet: { diamonds: 1000 } });
    const frame = await item({ name: 'Picky' });
    await buy('picky', frame.id);
    expect((await equip('picky', frame.id, 'entry_animation')).status).toBe(400);
    await equip('picky', frame.id, 'frame').expect(204);
    await equip('picky', null, 'frame').expect(204);
    const doc = (await h.ctx.col.users.findOne({ _id: 'picky' }))!;
    expect(doc.equipped.frameId).toBeNull();
    expect(doc.equipped.frameExpiresAt).toBeNull();
  });

  it('lists the store with the caller’s own state and hides chat bubbles', async () => {
    await h.user('shopper', { wallet: { diamonds: 1000 } });
    const owned = await item({ name: 'Owned One' });
    await h.ctx.col.cosmetics.insertOne({
      _id: new ObjectId(),
      type: 'chat_bubble',
      name: 'Legacy bubble',
      assetUrl: 'https://cdn.test/admin/cosmetics/b.png',
      previewUrl: null,
      animationFormat: 'none',
      priceDiamonds: 1,
      durationDays: 1,
      vipTierRequired: 0,
      vipIncluded: false,
      active: true,
      sortOrder: 0,
      createdAt: h.clock.now(),
    });
    await buy('shopper', owned.id);
    await equip('shopper', owned.id, 'frame').expect(204);
    const all = await h.api.get('/v1/store/items').set(h.as('shopper'));
    const row = all.body.items.find((i: { id: string }) => i.id === owned.id);
    expect(row).toMatchObject({ owned: true, equipped: true });
    expect(row.ownedUntil).toBeTruthy();
    expect(all.body.items.some((i: { type: string }) => i.type === 'chat_bubble')).toBe(false);
    const bubbles = await h.api.get('/v1/store/items?type=chat_bubble').set(h.as('shopper'));
    expect(bubbles.body.items).toEqual([]);
    await expect(item({ type: 'chat_bubble', name: 'New bubble' })).rejects.toThrow();
  });
});

describe('equipping reaches live rooms', () => {
  it('a host’s new frame is re-minted, and an equipped background becomes the backdrop', async () => {
    await h.user('star', { wallet: { diamonds: 10_000 } });
    const res = await h.api.post('/v1/live').set(h.as('star')).send({ type: 'video' });
    const roomId: string = res.body.room.id;
    expect(res.body.room.backgroundUrl).toBeNull();

    const frame = await item({ name: 'Stage frame' });
    await buy('star', frame.id);
    await equip('star', frame.id, 'frame').expect(204);
    const mint = h.livekit.permissions.filter((p) => p.identity === 'star').at(-1)!;
    expect(mint.metadata?.frameUrl).toBe(frame.assetUrl);

    const bg = await item({
      type: 'room_background',
      name: 'Night sky',
      assetUrl: 'https://cdn.test/admin/cosmetics/sky.png',
      animationFormat: 'none',
    });
    await buy('star', bg.id);
    await equip('star', bg.id, 'room_background').expect(204);
    const detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('star'));
    expect(detail.body.room.backgroundUrl).toBe(bg.assetUrl);
    const update = h.livekit
      .topics('bb.system')
      .map((d) => d.payload as { kind: string; backgroundUrl?: string })
      .filter((p) => p.kind === 'room_updated')
      .at(-1);
    expect(update?.backgroundUrl).toBe(bg.assetUrl);

    // A background set for this live still wins.
    await h.api
      .patch(`/v1/live/${roomId}`)
      .set(h.as('star'))
      .send({ backgroundUrl: 'https://cdn.test/admin/live/custom.png' })
      .expect(200);
    await equip('star', null, 'room_background').expect(204);
    const after = await h.api.get(`/v1/live/${roomId}`).set(h.as('star'));
    expect(after.body.room.backgroundUrl).toBe('https://cdn.test/admin/live/custom.png');
  });

  it('a reconnect does not replay the entrance', async () => {
    await h.user('regular', { vip: { tier: 1, expiresAt: new Date('2099-01-01') } });
    h.clock.advance(1);
    const res = await h.api.post('/v1/live').set(h.as('hoster')).send({ type: 'video' });
    const roomId: string = res.body.room.id;
    const livekitRoom: string = res.body.room.livekitRoom;
    const entries = () => h.livekit.topics('bb.entry').filter((d) => d.room === livekitRoom).length;

    const first = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('regular'));
    expect(first.body.entry).not.toBeNull();
    expect(entries()).toBe(1);
    const resumed = await h.api
      .post(`/v1/live/${roomId}/join`)
      .set(h.as('regular'))
      .send({ resume: true });
    expect(resumed.body.entry).toBeNull();
    await h.api
      .post('/v1/webhooks/livekit')
      .set('Authorization', 'valid-signature')
      .set('Content-Type', 'application/webhook+json')
      .send(
        JSON.stringify({
          event: 'participant_joined',
          room: { name: livekitRoom },
          participant: { identity: 'regular' },
        }),
      );
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('regular'));
    expect(entries()).toBe(1);
  });
});

beforeAll(async () => {
  await h.user('hoster');
});
