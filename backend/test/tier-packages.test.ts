import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
const ADMIN = { uid: 'tier-admin', role: 'admin' } as const;
const admin = () => h.as(ADMIN.uid, ADMIN.role);
const DAY = 86_400_000;

interface Pkg {
  id: string;
  tier: number;
  name: string;
  badge: { imageUrl: string | null; svgaUrl: string | null; mp4Url: string | null };
}

async function create(o: Record<string, unknown> = {}): Promise<Pkg> {
  const res = await h.api
    .post('/v1/admin/tier-packages')
    .set(admin())
    .send({
      tier: 3,
      name: 'Rose Crown',
      priceDiamonds: 1000,
      durationDays: 30,
      badgeUrl: 'https://cdn.test/admin/tiers/badges/a/rose.png',
      badgeSvgaUrl: 'https://cdn.test/admin/tiers/badges/a/rose.svga',
      ...o,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.item as Pkg;
}

const buy = (uid: string, id: string, k = key()) =>
  h.api.post(`/v1/store/tier-packages/${id}/purchase`).set(h.as(uid)).set('Idempotency-Key', k);
const wear = (uid: string, packageId: string | null) =>
  h.api.post('/v1/store/tier-packages/wear').set(h.as(uid)).send({ packageId });
const brief = async (uid: string) => (await h.ctx.services.users.briefs([uid])).get(uid)!;
const diamonds = async (uid: string) =>
  (await h.ctx.col.users.findOne({ _id: uid }))!.wallet.diamonds;

beforeAll(async () => {
  h = await createHarness();
  await h.user(ADMIN.uid, { adminRole: ADMIN.role });
  await h.user('helpdesk', { adminRole: 'support' });
  await h.user('shopper');
});
afterAll(async () => h.close());

describe('tier package catalog', () => {
  it('validates the badge slots and never changes the tier', async () => {
    const bad = (o: Record<string, unknown>) =>
      h.api
        .post('/v1/admin/tier-packages')
        .set(admin())
        .send({ tier: 1, name: 'X', priceDiamonds: 1, durationDays: 1, ...o });
    expect((await bad({})).status).toBe(400); // no artwork
    expect((await bad({ badgeUrl: 'https://cdn.test/a.mp4' })).status).toBe(400);
    expect((await bad({ badgeSvgaUrl: 'https://cdn.test/a.png' })).status).toBe(400);
    expect((await bad({ badgeMp4Url: 'https://cdn.test/a.svga' })).status).toBe(400);
    expect((await bad({ tier: 5, badgeUrl: 'https://cdn.test/a.png' })).status).toBe(422);
    // An extensionless (signed/CDN) URL keeps its slot.
    expect((await bad({ badgeMp4Url: 'https://cdn.test/v/abc' })).status).toBe(201);

    const pkg = await create({ name: 'Fixed tier' });
    const patch = (body: Record<string, unknown>) =>
      h.api.patch(`/v1/admin/tier-packages/${pkg.id}`).set(admin()).send(body);
    expect((await patch({ tier: 4 })).status).toBe(400);
    const ok = await patch({ priceDiamonds: 5 });
    expect(ok.body.item).toMatchObject({ tier: 3, priceDiamonds: 5, name: 'Fixed tier' });
    expect(ok.body.item.badge.svgaUrl).toBe(pkg.badge.svgaUrl);
    expect((await patch({ badgeUrl: null, badgeSvgaUrl: null })).status).toBe(400);
  });

  it('lists active packages by tier; the admin list filters and counts holders', async () => {
    await create({ tier: 4, name: 'Shop King' });
    await create({ tier: 4, name: 'Hidden King', active: false });
    const shop = await h.api.get('/v1/store/tier-packages').query({ tier: 4 }).set(h.as('shopper'));
    expect(shop.body.items.map((p: Pkg) => p.name)).toEqual(['Shop King']);

    const list = await h.api
      .get('/v1/admin/tier-packages')
      .query({ tier: 4, status: 'inactive' })
      .set(admin());
    expect(list.body.items.map((p: Pkg) => p.name)).toEqual(['Hidden King']);
    expect(list.body.items[0].ownerCount).toBe(0);
    expect(
      (await h.api.get('/v1/admin/tier-packages').set(h.as('helpdesk', 'support'))).status,
    ).toBe(403);
  });
});

describe('buying and wearing', () => {
  it('debits once, wears at once, and a rebuy extends the same row', async () => {
    const pkg = await create({ name: 'Buyable Crown' });
    await h.user('buyer', { wallet: { diamonds: 5000 } });
    const k = key();
    const first = await buy('buyer', pkg.id, k);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ tier: 3, diamonds: 4000, replayed: false });
    const replay = await buy('buyer', pkg.id, k);
    expect(replay.body).toMatchObject({ replayed: true, expiresAt: first.body.expiresAt });
    expect(await diamonds('buyer')).toBe(4000);

    expect(await brief('buyer')).toMatchObject({
      vipTier: 3,
      badge: { svgaUrl: pkg.badge.svgaUrl, imageUrl: pkg.badge.imageUrl, blendMode: 'normal' },
    });

    const renew = await buy('buyer', pkg.id);
    expect(
      new Date(renew.body.expiresAt).getTime() - new Date(first.body.expiresAt).getTime(),
    ).toBe(30 * DAY);
    expect(await h.ctx.col.userTierPackages.countDocuments({ userId: 'buyer' })).toBe(1);
    const ledger = await h.ctx.col.ledger
      .find({ userId: 'buyer', reason: 'vip_purchase' })
      .toArray();
    expect(ledger).toHaveLength(2);
    // Purchases never move level.
    expect((await h.ctx.col.users.findOne({ _id: 'buyer' }))!.level.points).toBe(0);
  });

  it('refuses a short balance and inactive packages', async () => {
    const pkg = await create({ name: 'Pricey', priceDiamonds: 10_000 });
    await h.user('poor', { wallet: { diamonds: 10 } });
    expect((await buy('poor', pkg.id)).status).toBe(402);
    const off = await create({ name: 'Off', active: false });
    expect((await buy('poor', off.id)).status).toBe(404);
    expect(await brief('poor')).toMatchObject({ vipTier: 0, badge: null });
  });

  it('wears any owned package, including a lower tier, and takes it off', async () => {
    const vip = await create({ tier: 1, name: 'Little VIP', priceDiamonds: 10 });
    const king = await create({ tier: 4, name: 'Big King', priceDiamonds: 10 });
    await h.user('switcher', { wallet: { diamonds: 100 } });
    await buy('switcher', vip.id).expect(200);
    await buy('switcher', king.id).expect(200);
    expect((await brief('switcher')).vipTier).toBe(4);

    await wear('switcher', vip.id).expect(204);
    expect((await brief('switcher')).vipTier).toBe(1);
    const mine = await h.api.get('/v1/store/tier-packages/mine').set(h.as('switcher'));
    expect(
      mine.body.items.map((o: { package: Pkg; worn: boolean }) => [o.package.name, o.worn]),
    ).toEqual(
      expect.arrayContaining([
        ['Little VIP', true],
        ['Big King', false],
      ]),
    );
    const onlyKings = await h.api
      .get('/v1/store/tier-packages/mine')
      .query({ tier: 4 })
      .set(h.as('switcher'));
    expect(onlyKings.body.items).toHaveLength(1);

    await wear('switcher', null).expect(204);
    expect(await brief('switcher')).toMatchObject({ vipTier: 0, badge: null });
    expect((await wear('switcher', new ObjectId().toHexString())).status).toBe(403);
  });

  it('a catalog edit re-syncs the badge of everyone wearing it', async () => {
    const pkg = await create({ name: 'Evolving', priceDiamonds: 0 });
    await h.user('wearer');
    await buy('wearer', pkg.id).expect(200);
    await h.api
      .patch(`/v1/admin/tier-packages/${pkg.id}`)
      .set(admin())
      .send({ badgeMp4Url: 'https://cdn.test/v2.mp4', badgeBlendMode: 'additive' })
      .expect(200);
    expect((await brief('wearer')).badge).toMatchObject({
      mp4Url: 'https://cdn.test/v2.mp4',
      blendMode: 'additive',
      svgaUrl: pkg.badge.svgaUrl,
    });
  });

  it('expires at read time; the sweep clears the slot and drops the live room rank', async () => {
    const pkg = await create({ tier: 4, name: 'Short King', durationDays: 2, priceDiamonds: 0 });
    await h.user('fading');
    await buy('fading', pkg.id).expect(200);
    const { room } = await h.ctx.services.live.start('fading', {
      type: 'audio',
      title: 'Royal talk',
      coverUrl: null,
      tags: [],
    });
    const rank = async () =>
      (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(room.id) }))!.hostVipTier;
    expect(await rank()).toBe(4);

    h.clock.advance(3 * 86_400);
    expect(await brief('fading')).toMatchObject({ vipTier: 0, badge: null });
    expect((await wear('fading', pkg.id)).status).toBe(400);
    expect(await h.ctx.services.tierPackages.sweep()).toBeGreaterThanOrEqual(1);
    expect((await h.ctx.col.users.findOne({ _id: 'fading' }))!.vip).toMatchObject({
      tier: 0,
      packageId: null,
    });
    expect(await rank()).toBe(0);
  });
});

describe('admin grants and removal', () => {
  const grant = (uid: string, body: Record<string, unknown>, k = key()) =>
    h.api
      .post(`/v1/admin/users/${uid}/tier-packages`)
      .set(admin())
      .set('Idempotency-Key', k)
      .send(body);

  it('grants free, wears it, honours a days override and replays a retry', async () => {
    const pkg = await create({ tier: 4, name: 'Granted King', active: false });
    await h.user('lucky');
    const k = key();
    const a = await grant('lucky', { packageId: pkg.id, days: 7 }, k);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(new Date(a.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(7 * DAY);
    const b = await grant('lucky', { packageId: pkg.id, days: 7 }, k);
    expect(b.body).toMatchObject({ replayed: true, expiresAt: a.body.expiresAt });
    expect(
      await h.ctx.col.auditLogs.countDocuments({
        action: 'user.tier_package.grant',
        targetId: 'lucky',
      }),
    ).toBe(1);
    expect(await diamonds('lucky')).toBe(0);
    expect((await brief('lucky')).vipTier).toBe(4);

    const listed = await h.api.get('/v1/admin/users/lucky/tier-packages').set(admin());
    expect(listed.body.items[0]).toMatchObject({
      worn: true,
      source: 'admin',
      grantedBy: ADMIN.uid,
    });

    // Without a key the grant is refused.
    expect(
      (
        await h.api
          .post('/v1/admin/users/lucky/tier-packages')
          .set(admin())
          .send({ packageId: pkg.id })
      ).status,
    ).toBe(400);
  });

  it('removal takes the package off; a held package cannot be deleted', async () => {
    const pkg = await create({ name: 'Taken back', priceDiamonds: 0 });
    await h.user('revoked');
    await grant('revoked', { packageId: pkg.id }).expect(200);
    expect((await h.api.delete(`/v1/admin/tier-packages/${pkg.id}`).set(admin())).status).toBe(409);

    await h.api.delete(`/v1/admin/users/revoked/tier-packages/${pkg.id}`).set(admin()).expect(204);
    expect(await brief('revoked')).toMatchObject({ vipTier: 0, badge: null });
    await h.api.delete(`/v1/admin/tier-packages/${pkg.id}`).set(admin()).expect(204);
  });
});
