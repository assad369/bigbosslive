import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { MAX_COSMETICS_PER_BATCH } from '@bigboss/shared';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
const ADMIN = { uid: 'deco-admin', role: 'admin' } as const;
const admin = () => h.as(ADMIN.uid, ADMIN.role);
const DAY = 86_400_000;

const frame = (o: Record<string, unknown> = {}) => ({
  type: 'frame',
  name: 'Gilded',
  assetUrl: 'https://cdn.test/admin/cosmetics/assets/a/gilded.svga',
  animationFormat: 'svga',
  priceDiamonds: 100,
  durationDays: 7,
  ...o,
});

async function create(o: Record<string, unknown> = {}) {
  const res = await h.api.post('/v1/admin/cosmetics').set(admin()).send(frame(o));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.item as { id: string; sortOrder: number; vipIncluded: boolean };
}

const userDoc = async (uid: string) => (await h.ctx.col.users.findOne({ _id: uid }))!;
const brief = async (uid: string) => (await h.ctx.services.users.briefs([uid])).get(uid)!;

beforeAll(async () => {
  h = await createHarness();
  await h.user(ADMIN.uid, { adminRole: ADMIN.role });
  await h.user('helpdesk', { adminRole: 'support' });
  await h.ctx.services.store.upsertVipPackage(null, {
    tier: 3,
    name: 'King',
    priceDiamonds: 100,
    durationDays: 30,
    perks: [],
    badgeUrl: null,
    frameUrl: 'https://cdn.test/vip/king.svga',
    frameFormat: 'svga',
    entryAnimationUrl: 'https://cdn.test/vip/king-entry.mp4',
    entryAnimationFormat: 'mp4',
    active: true,
    sortOrder: 0,
  });
});
afterAll(async () => h.close());

describe('decoration catalog', () => {
  it('creates, pages, filters and patches without resetting unsent fields', async () => {
    const a = await create({ name: 'Rose ring', sortOrder: 7 });
    await create({ name: 'Crown halo', vipTierRequired: 3, vipIncluded: true, priceDiamonds: 0 });
    await create({
      type: 'entry_animation',
      name: 'Rose rain',
      assetUrl: 'https://cdn.test/x/rain.mp4',
      animationFormat: 'mp4',
    });

    const roses = await h.api.get('/v1/admin/cosmetics').query({ q: 'rose' }).set(admin());
    expect(roses.body.total).toBe(2);
    const frames = await h.api
      .get('/v1/admin/cosmetics')
      .query({ type: 'frame', access: 'included', vipTier: 3 })
      .set(admin());
    expect(frames.body.items.map((i: { name: string }) => i.name)).toEqual(['Crown halo']);
    const paged = await h.api.get('/v1/admin/cosmetics').query({ pageSize: 1 }).set(admin());
    expect(paged.body).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.items[0]).toMatchObject({ ownerCount: 0 });

    const patched = await h.api
      .patch(`/v1/admin/cosmetics/${a.id}`)
      .set(admin())
      .send({ active: false });
    expect(patched.body.item).toMatchObject({ active: false, sortOrder: 7, priceDiamonds: 100 });
    expect(
      (await h.api.patch(`/v1/admin/cosmetics/${a.id}`).set(admin()).send({ type: 'chat_bubble' }))
        .status,
    ).toBe(400);
  });

  it('rejects inconsistent decorations', async () => {
    const bad = [
      frame({ assetUrl: 'https://cdn.test/f.mp4', animationFormat: 'mp4' }),
      frame({ vipIncluded: true, vipTierRequired: 0 }),
      frame({ assetUrl: 'https://cdn.test/f.svga', animationFormat: 'none' }),
    ];
    for (const body of bad)
      expect((await h.api.post('/v1/admin/cosmetics').set(admin()).send(body)).status).toBe(400);
  });

  it('bulk-creates up to the batch limit, all or nothing', async () => {
    const items = Array.from({ length: MAX_COSMETICS_PER_BATCH }, (_, i) =>
      frame({
        name: `Bulk ${i}`,
        assetUrl: `https://cdn.test/bulk/${i}.png`,
        animationFormat: 'none',
      }),
    );
    const ok = await h.api.post('/v1/admin/cosmetics/bulk').set(admin()).send({ items });
    expect(ok.status).toBe(201);
    expect(ok.body.items).toHaveLength(MAX_COSMETICS_PER_BATCH);
    expect(await h.ctx.col.auditLogs.findOne({ action: 'cosmetic.bulk_create' })).toBeTruthy();

    const tooMany = [...items, frame()];
    expect(
      (await h.api.post('/v1/admin/cosmetics/bulk').set(admin()).send({ items: tooMany })).status,
    ).toBe(422);

    const before = await h.ctx.col.cosmetics.countDocuments();
    const oneBad = await h.api
      .post('/v1/admin/cosmetics/bulk')
      .set(admin())
      .send({ items: [frame({ name: 'Fine' }), frame({ animationFormat: 'mp4' })] });
    expect(oneBad.status).toBe(400);
    expect(oneBad.body.error.message).toMatch(/^Item 2:/);
    expect(await h.ctx.col.cosmetics.countDocuments()).toBe(before);
  });

  it('deletes only decorations nobody holds or wears', async () => {
    const unused = await create({ name: 'Typo' });
    await h.api.delete(`/v1/admin/cosmetics/${unused.id}`).set(admin()).expect(204);
    expect(await h.ctx.col.cosmetics.findOne({ _id: new ObjectId(unused.id) })).toBeNull();

    const held = await create({ name: 'Held' });
    await h.user('holder');
    await h.api
      .post('/v1/admin/users/holder/cosmetics')
      .set(admin())
      .set('Idempotency-Key', key())
      .send({ cosmeticId: held.id })
      .expect(200);
    expect((await h.api.delete(`/v1/admin/cosmetics/${held.id}`).set(admin())).status).toBe(409);
  });

  it('catalog routes need catalog.manage', async () => {
    expect((await h.api.get('/v1/admin/cosmetics').set(h.as('helpdesk', 'support'))).status).toBe(
      403,
    );
    expect(
      (await h.api.post('/v1/admin/cosmetics/bulk').set(h.as('helpdesk', 'support')).send({}))
        .status,
    ).toBe(403);
  });
});

describe('admin grants', () => {
  it('grants a frame, wears it at once, and a retry does not stack days', async () => {
    const item = await create({ name: 'Granted ring', durationDays: 10 });
    await h.user('lucky');
    const k = key();
    const send = () =>
      h.api
        .post('/v1/admin/users/lucky/cosmetics')
        .set(admin())
        .set('Idempotency-Key', k)
        .send({ cosmeticId: item.id, days: 5 });
    const first = await send();
    expect(first.body).toMatchObject({ equipped: true, days: 5, replayed: false });
    const again = await send();
    expect(again.body).toMatchObject({ replayed: true, expiresAt: first.body.expiresAt });
    expect(new Date(first.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(5 * DAY);

    const u = await userDoc('lucky');
    expect(u.equipped).toMatchObject({
      frameId: new ObjectId(item.id),
      frameUrl: 'https://cdn.test/admin/cosmetics/assets/a/gilded.svga',
      frameVipTier: 0,
    });
    expect(
      await h.ctx.col.auditLogs.countDocuments({
        action: 'user.cosmetic.grant',
        targetId: 'lucky',
      }),
    ).toBe(1);

    // A second grant extends the unexpired hold; the default length is the item's.
    const more = await h.api
      .post('/v1/admin/users/lucky/cosmetics')
      .set(admin())
      .set('Idempotency-Key', key())
      .send({ cosmeticId: item.id });
    expect(new Date(more.body.expiresAt).getTime() - new Date(first.body.expiresAt).getTime()).toBe(
      10 * DAY,
    );

    const view = await h.api.get('/v1/admin/users/lucky/cosmetics').set(admin());
    expect(view.body.frame.frameUrl).toBe('https://cdn.test/admin/cosmetics/assets/a/gilded.svga');
    expect(view.body.items[0]).toMatchObject({
      source: 'owned',
      equipped: true,
      grantSource: 'admin',
      grantedBy: ADMIN.uid,
    });
  });

  it('grants inactive items and entrance effects, and revokes them', async () => {
    const effect = await create({
      type: 'entry_animation',
      name: 'Event entrance',
      assetUrl: 'https://cdn.test/x/event.svga',
      active: false,
    });
    await h.user('eventee');
    await h.api
      .post('/v1/admin/users/eventee/cosmetics')
      .set(admin())
      .set('Idempotency-Key', key())
      .send({ cosmeticId: effect.id })
      .expect(200);
    expect(await h.ctx.services.store.entryEffectFor('eventee', 0)).toEqual({
      url: 'https://cdn.test/x/event.svga',
      format: 'svga',
    });

    await h.api.delete(`/v1/admin/users/eventee/cosmetics/${effect.id}`).set(admin()).expect(204);
    expect((await userDoc('eventee')).equipped.entryAnimationId).toBeNull();
    expect(await h.ctx.services.store.entryEffectFor('eventee', 0)).toBeNull();
    expect(
      (await h.api.delete(`/v1/admin/users/eventee/cosmetics/${effect.id}`).set(admin())).status,
    ).toBe(404);
  });

  it('editing a frame re-syncs everyone wearing it', async () => {
    const item = await create({ name: 'Morphing' });
    await h.user('wearer');
    await h.api
      .post('/v1/admin/users/wearer/cosmetics')
      .set(admin())
      .set('Idempotency-Key', key())
      .send({ cosmeticId: item.id })
      .expect(200);
    await h.api
      .patch(`/v1/admin/cosmetics/${item.id}`)
      .set(admin())
      .send({ assetUrl: 'https://cdn.test/v2.png', animationFormat: 'none' })
      .expect(200);
    expect(await brief('wearer')).toMatchObject({
      frameUrl: 'https://cdn.test/v2.png',
      frameFormat: 'none',
    });
  });

  it('support staff can look but not grant', async () => {
    await h.user('peek');
    await h.api.get('/v1/admin/users/peek/cosmetics').set(h.as('helpdesk', 'support')).expect(200);
    const item = await create({ name: 'Nope' });
    expect(
      (
        await h.api
          .post('/v1/admin/users/peek/cosmetics')
          .set(h.as('helpdesk', 'support'))
          .set('Idempotency-Key', key())
          .send({ cosmeticId: item.id })
      ).status,
    ).toBe(403);
  });
});

describe('admin VIP grants', () => {
  const grant = (uid: string, body: Record<string, unknown>, k = key()) =>
    h.api.post(`/v1/admin/users/${uid}/vip`).set(admin()).set('Idempotency-Key', k).send(body);

  it('extends the same tier, replaces on set, and removes with tier 0', async () => {
    await h.user('member');
    const first = await grant('member', { tier: 2, days: 10 });
    expect(first.status).toBe(200);
    const extended = await grant('member', { tier: 2, days: 5 });
    expect(new Date(extended.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(15 * DAY);
    const set = await grant('member', { tier: 2, days: 3, mode: 'set' });
    expect(new Date(set.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(3 * DAY);
    // A different tier starts from now even when extending.
    const upgraded = await grant('member', { tier: 3, days: 4 });
    expect(new Date(upgraded.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(4 * DAY);
    expect(await brief('member')).toMatchObject({
      vipTier: 3,
      frameUrl: 'https://cdn.test/vip/king.svga',
    });

    expect((await grant('member', { tier: 1 })).status).toBe(422);
    const removed = await grant('member', { tier: 0 });
    expect(removed.body).toMatchObject({ tier: 0, expiresAt: null });
    expect(await brief('member')).toMatchObject({ vipTier: 0, frameUrl: null });
  });

  it('a retried grant replays instead of stacking days', async () => {
    await h.user('retry');
    const k = key();
    const a = await grant('retry', { tier: 1, days: 30 }, k);
    const b = await grant('retry', { tier: 1, days: 30 }, k);
    expect(b.body).toMatchObject({ replayed: true, expiresAt: a.body.expiresAt });
    expect(
      await h.ctx.col.auditLogs.countDocuments({ action: 'user.vip', targetId: 'retry' }),
    ).toBe(1);
    expect(
      (await h.api.post('/v1/admin/users/retry/vip').set(admin()).send({ tier: 1, days: 1 }))
        .status,
    ).toBe(400);
  });

  it('re-ranks the live room of a host who is on air', async () => {
    await h.user('onair');
    const { room } = await h.ctx.services.live.start('onair', {
      type: 'audio',
      title: 'Talk',
      coverUrl: null,
      tags: [],
    });
    await grant('onair', { tier: 3, days: 30 }).expect(200);
    expect((await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(room.id) }))!.hostVipTier).toBe(
      3,
    );
  });
});

describe('decorations included with VIP', () => {
  it('holders wear them free; others cannot; buying is refused', async () => {
    const halo = await create({
      name: 'King halo',
      vipTierRequired: 3,
      vipIncluded: true,
      priceDiamonds: 0,
    });
    await h.user('royal', {
      vip: { tier: 3, expiresAt: new Date(h.clock.now().getTime() + 10 * DAY) },
    });
    await h.user('commoner', {
      vip: { tier: 1, expiresAt: new Date(h.clock.now().getTime() + 10 * DAY) },
    });

    const mine = await h.api.get('/v1/store/mine').set(h.as('royal'));
    expect(
      mine.body.items.find((o: { item: { id: string } }) => o.item.id === halo.id),
    ).toMatchObject({
      source: 'vip',
      equipped: false,
    });
    expect(
      (await h.api.get('/v1/store/mine').set(h.as('commoner'))).body.items.some(
        (o: { item: { id: string } }) => o.item.id === halo.id,
      ),
    ).toBe(false);

    await h.api
      .post('/v1/store/equip')
      .set(h.as('royal'))
      .send({ itemId: halo.id, type: 'frame' })
      .expect(204);
    expect((await userDoc('royal')).equipped.frameVipTier).toBe(3);
    expect((await brief('royal')).frameUrl).toBe(
      'https://cdn.test/admin/cosmetics/assets/a/gilded.svga',
    );
    expect(
      (
        await h.api
          .post('/v1/store/equip')
          .set(h.as('commoner'))
          .send({ itemId: halo.id, type: 'frame' })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.api
          .post(`/v1/store/items/${halo.id}/purchase`)
          .set(h.as('royal'))
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(400);

    // Owner counts include admin grants only, never entitlements.
    const listed = await h.api.get('/v1/admin/cosmetics').query({ q: 'King halo' }).set(admin());
    expect(listed.body.items[0]).toMatchObject({ ownerCount: 0, vipIncluded: true });
    // Deleting it while worn is refused.
    expect((await h.api.delete(`/v1/admin/cosmetics/${halo.id}`).set(admin())).status).toBe(409);
  });

  it('a lapsed membership drops them at read time and the sweep takes them off', async () => {
    const effect = await create({
      type: 'entry_animation',
      name: 'King steps',
      assetUrl: 'https://cdn.test/x/steps.svga',
      vipTierRequired: 3,
      vipIncluded: true,
    });
    const ring = await create({ name: 'King ring', vipTierRequired: 3, vipIncluded: true });
    await h.user('fleeting', {
      vip: { tier: 3, expiresAt: new Date(h.clock.now().getTime() + 2 * DAY) },
    });
    for (const [id, type] of [
      [effect.id, 'entry_animation'],
      [ring.id, 'frame'],
    ])
      await h.api
        .post('/v1/store/equip')
        .set(h.as('fleeting'))
        .send({ itemId: id, type })
        .expect(204);
    expect(await h.ctx.services.store.entryEffectFor('fleeting', 3)).toMatchObject({
      url: 'https://cdn.test/x/steps.svga',
    });

    h.clock.advance(3 * 86_400);
    expect(await brief('fleeting')).toMatchObject({ vipTier: 0, frameUrl: null });
    expect(await h.ctx.services.store.entryEffectFor('fleeting', 0)).toBeNull();
    await h.ctx.services.store.sweepExpired();
    expect((await userDoc('fleeting')).equipped).toMatchObject({
      frameId: null,
      entryAnimationId: null,
    });
  });

  it('raising the tier hides it from lower holders; un-including takes it off', async () => {
    const item = await create({ name: 'Shifting', vipTierRequired: 1, vipIncluded: true });
    await h.user('vip1', {
      vip: { tier: 1, expiresAt: new Date(h.clock.now().getTime() + 30 * DAY) },
    });
    await h.api
      .post('/v1/store/equip')
      .set(h.as('vip1'))
      .send({ itemId: item.id, type: 'frame' })
      .expect(204);

    await h.api
      .patch(`/v1/admin/cosmetics/${item.id}`)
      .set(admin())
      .send({ vipTierRequired: 2 })
      .expect(200);
    expect((await userDoc('vip1')).equipped.frameVipTier).toBe(2);
    expect((await brief('vip1')).frameUrl).toBeNull();

    await h.api
      .patch(`/v1/admin/cosmetics/${item.id}`)
      .set(admin())
      .send({ vipIncluded: false })
      .expect(200);
    expect((await userDoc('vip1')).equipped.frameId).toBeNull();
  });
});
