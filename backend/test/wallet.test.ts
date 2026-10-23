import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.ctx.services.levels.replaceAll([
    { level: 1, pointsRequired: 1000, name: 'Bronze', color: '#8C6239', iconUrl: null },
    { level: 2, pointsRequired: 5000, name: 'Silver', color: '#C0C0C0', iconUrl: null },
  ]);
  await h.user('agent', { isAgent: true, wallet: { agentStock: 10_000 } });
  await h.user('buyer', { shortId: '55555555' });
  await h.user('fin', { adminRole: 'finance' });
  await h.ctx.services.iap.upsertPackage(null, { sku: 'diamonds_1000', diamonds: 1000, bonusDiamonds: 100, priceUsd: 0.99, active: true, sortOrder: 0 });
});
afterAll(async () => h.close());

describe('wallet & recharges', () => {
  it('agents recharge by short id; stock moves to diamonds and level points', async () => {
    const res = await h.api.post('/v1/agent/recharge').set(h.as('agent')).set('Idempotency-Key', key()).send({ target: '55555555', diamonds: 6000 });
    expect(res.status).toBe(200);
    expect(res.body.agentStock).toBe(4000);
    const buyer = await h.ctx.col.users.findOne({ _id: 'buyer' });
    expect(buyer!.wallet.diamonds).toBe(6000);
    expect(buyer!.stats.totalRecharged).toBe(6000);
    expect(buyer!.level).toEqual({ level: 2, points: 6000 });
  });

  it('agents cannot exceed their stock and non-agents cannot recharge', async () => {
    const over = await h.api.post('/v1/agent/recharge').set(h.as('agent')).set('Idempotency-Key', key()).send({ target: 'buyer', diamonds: 999_999 });
    expect(over.status).toBe(402);
    expect((await h.api.post('/v1/agent/recharge').set(h.as('buyer')).set('Idempotency-Key', key()).send({ target: 'agent', diamonds: 1 })).status).toBe(403);
  });

  it('admin balance corrections do not move level', async () => {
    await h.api.post('/v1/admin/users/buyer/wallet/adjust').set(h.as('fin', 'finance')).send({ currency: 'diamonds', delta: -1000, note: 'chargeback' }).expect(200);
    const buyer = await h.ctx.col.users.findOne({ _id: 'buyer' });
    expect(buyer!.wallet.diamonds).toBe(5000);
    expect(buyer!.level.points).toBe(6000);
    const neg = await h.api.post('/v1/admin/users/buyer/wallet/adjust').set(h.as('fin', 'finance')).send({ currency: 'diamonds', delta: -999_999, note: 'too much' });
    expect(neg.status).toBe(402);
  });

  it('paginates the ledger with a cursor', async () => {
    const page1 = await h.api.get('/v1/wallet/ledger?limit=1').set(h.as('buyer'));
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await h.api.get(`/v1/wallet/ledger?limit=1&cursor=${page1.body.nextCursor}`).set(h.as('buyer'));
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it('credits verified Google Play purchases exactly once and consumes them', async () => {
    h.iap.google.set('tok-1234567890', { productId: 'diamonds_1000', orderId: 'GPA.1' });
    const first = await h.api.post('/v1/wallet/iap/verify').set(h.as('buyer')).send({ store: 'google', productId: 'diamonds_1000', purchaseToken: 'tok-1234567890' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ credited: 1100, replayed: false });
    expect(h.iap.consumed).toContain('tok-1234567890');
    const replay = await h.api.post('/v1/wallet/iap/verify').set(h.as('buyer')).send({ store: 'google', productId: 'diamonds_1000', purchaseToken: 'tok-1234567890' });
    expect(replay.body).toMatchObject({ credited: 0, replayed: true });
    // Another account cannot redeem the same purchase.
    await h.user('thief');
    const stolen = await h.api.post('/v1/wallet/iap/verify').set(h.as('thief')).send({ store: 'google', productId: 'diamonds_1000', purchaseToken: 'tok-1234567890' });
    expect(stolen.status).toBe(409);
  });

  it('credits verified App Store purchases', async () => {
    h.iap.apple.set('2000000123', { productId: 'diamonds_1000' });
    const res = await h.api.post('/v1/wallet/iap/verify').set(h.as('buyer')).send({ store: 'apple', transactionId: '2000000123' });
    expect(res.body.credited).toBe(1100);
  });
});

describe('VIP & cosmetics', () => {
  it('buys, renews and refuses downgrades', async () => {
    const vip1 = await h.ctx.services.store.upsertVipPackage(null, { tier: 1, name: 'VIP 1', priceDiamonds: 500, durationDays: 30, perks: [], badgeUrl: null, frameUrl: null, active: true, sortOrder: 0 });
    const vip2 = await h.ctx.services.store.upsertVipPackage(null, { tier: 2, name: 'VIP 2', priceDiamonds: 1000, durationDays: 30, perks: [], badgeUrl: null, frameUrl: null, active: true, sortOrder: 1 });
    const buy = await h.api.post(`/v1/store/vip/${vip1._id}/purchase`).set(h.as('buyer')).set('Idempotency-Key', key());
    expect(buy.body.tier).toBe(1);
    const renew = await h.api.post(`/v1/store/vip/${vip1._id}/purchase`).set(h.as('buyer')).set('Idempotency-Key', key());
    expect(new Date(renew.body.expiresAt).getTime() - new Date(buy.body.expiresAt).getTime()).toBe(30 * 86_400_000);
    await h.api.post(`/v1/store/vip/${vip2._id}/purchase`).set(h.as('buyer')).set('Idempotency-Key', key()).expect(200);
    expect((await h.api.post(`/v1/store/vip/${vip1._id}/purchase`).set(h.as('buyer')).set('Idempotency-Key', key())).status).toBe(400);
  });

  it('purchase is idempotent and equipping requires ownership', async () => {
    const frame = await h.ctx.services.store.upsertCosmetic(null, { type: 'frame', name: 'Gilded', assetUrl: 'https://cdn.test/f.svga', previewUrl: null, animationFormat: 'svga', priceDiamonds: 200, durationDays: 7, vipTierRequired: 0, active: true, sortOrder: 0 });
    await h.user('fresh', { wallet: { diamonds: 1000 } });
    expect((await h.api.post('/v1/store/equip').set(h.as('fresh')).send({ itemId: frame.id, type: 'frame' })).status).toBe(403);
    const k = key();
    await h.api.post(`/v1/store/items/${frame.id}/purchase`).set(h.as('fresh')).set('Idempotency-Key', k).expect(200);
    const again = await h.api.post(`/v1/store/items/${frame.id}/purchase`).set(h.as('fresh')).set('Idempotency-Key', k);
    expect(again.body.replayed).toBe(true);
    expect((await h.ctx.col.users.findOne({ _id: 'fresh' }))!.wallet.diamonds).toBe(800);
    await h.api.post('/v1/store/equip').set(h.as('fresh')).send({ itemId: frame.id, type: 'frame' }).expect(204);
    expect((await h.ctx.col.users.findOne({ _id: 'fresh' }))!.equipped.frameUrl).toBe('https://cdn.test/f.svga');
    h.clock.advance(8 * 86400);
    await h.ctx.services.store.sweepExpired();
    expect((await h.ctx.col.users.findOne({ _id: 'fresh' }))!.equipped.frameId).toBeNull();
    expect(await h.ctx.col.userCosmetics.countDocuments({ userId: 'fresh', cosmeticId: new ObjectId(frame.id) })).toBe(1);
  });
});
