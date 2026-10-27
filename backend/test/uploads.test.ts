import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import { createS3Storage, s3SettingsFromEnv } from '../src/infra/storage.js';
import { createHarness, fakeStorage, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('modr', { adminRole: 'moderator' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('plain');
});
afterAll(async () => h.close());

const presign = (as: Record<string, string>, body: object) =>
  h.api.post('/v1/admin/uploads/presign').set(as).send(body);

describe('admin uploads', () => {
  it('presigns a catalog asset with a signed size and immutable caching', async () => {
    const res = await presign(h.as('boss', 'admin'), {
      kind: 'gift-animation',
      contentType: 'application/octet-stream',
      size: 1_500_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^admin\/gifts\/animations\/boss\/[0-9a-f-]+\.svga$/);
    expect(res.body.publicUrl).toBe(`https://cdn.test/${res.body.key}`);
    expect(res.body.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    expect(fakeStorage.last).toMatchObject({ contentLength: 1_500_000 });
  });

  it('scopes each kind to the permission of the entity it belongs to', async () => {
    const icon = { kind: 'gift-icon', contentType: 'image/png', size: 1000 };
    expect((await presign(h.as('modr', 'moderator'), icon)).status).toBe(403);
    // Finance manages agencies, so it may upload their logos but not catalog art.
    expect((await presign(h.as('fin', 'finance'), icon)).status).toBe(403);
    const logo = await presign(h.as('fin', 'finance'), { ...icon, kind: 'agency-logo' });
    expect(logo.status).toBe(200);
    expect(logo.body.key).toMatch(/^admin\/agencies\/fin\/.+\.png$/);
  });

  it('rejects non-admins', async () => {
    const res = await presign(h.as('plain'), {
      kind: 'banner',
      contentType: 'image/png',
      size: 1000,
    });
    expect(res.status).toBe(403);
  });

  it('rejects types and sizes the slot does not accept', async () => {
    const as = h.as('boss', 'admin');
    expect(
      (await presign(as, { kind: 'announcement', contentType: 'image/webp', size: 1000 })).status,
    ).toBe(400);
    expect(
      (await presign(as, { kind: 'banner', contentType: 'text/html', size: 1000 })).status,
    ).toBe(400);
    const big = await presign(as, {
      kind: 'gift-icon',
      contentType: 'image/png',
      size: 3 * 1024 * 1024,
    });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toMatch(/too large/);
    // Size is required: it is what gets signed.
    expect((await presign(as, { kind: 'banner', contentType: 'image/png' })).status).toBe(422);
  });
});

describe('user uploads', () => {
  it('signs the size when the app sends it and caps it per kind', async () => {
    const ok = await h.api
      .post('/v1/uploads/presign')
      .set(h.as('plain'))
      .send({ kind: 'cover', contentType: 'image/jpeg', size: 200_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.key).toMatch(/^covers\/plain\/.+\.jpg$/);
    expect(fakeStorage.last).toMatchObject({ contentLength: 200_000 });

    const legacy = await h.api
      .post('/v1/uploads/presign')
      .set(h.as('plain'))
      .send({ kind: 'avatar', contentType: 'image/png' });
    expect(legacy.status).toBe(200);
    expect(fakeStorage.last?.contentLength).toBeUndefined();

    const big = await h.api
      .post('/v1/uploads/presign')
      .set(h.as('plain'))
      .send({ kind: 'avatar', contentType: 'image/png', size: 6 * 1024 * 1024 });
    expect(big.status).toBe(400);
  });
});

describe('S3 presigning', () => {
  it('signs content length and cache control so the bucket enforces them', async () => {
    const settings = s3SettingsFromEnv({
      S3_REGION: 'auto',
      S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_PUBLIC_BASE_URL: 'https://cdn.example.com/',
    } as Env);
    const storage = createS3Storage(async () => settings);
    const p = await storage.presignUpload({
      folder: 'admin/banners',
      ownerId: 'boss',
      contentType: 'image/png',
      ext: 'png',
      contentLength: 1234,
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const signed = new URL(p.uploadUrl).searchParams.get('X-Amz-SignedHeaders')!.split(';');
    expect(signed).toEqual(
      expect.arrayContaining(['cache-control', 'content-length', 'content-type', 'host']),
    );
    expect(p.publicUrl).toBe(`https://cdn.example.com/${p.key}`);
    expect(p.headers).toEqual({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
});

describe('partial admin updates keep uploaded media', () => {
  it('toggling a gift does not reset its animation or other defaults', async () => {
    const as = h.as('boss', 'admin');
    const created = await h.api.post('/v1/admin/gifts').set(as).send({
      name: 'Dragon',
      price: 5000,
      iconUrl: 'https://cdn.test/admin/gifts/icons/dragon.png',
      animationUrl: 'https://cdn.test/admin/gifts/animations/dragon.svga',
      animationFormat: 'svga',
      category: 'luxury',
      sortOrder: 7,
      vipTierRequired: 2,
    });
    expect(created.status).toBe(201);
    const id = created.body.gift?.id ?? created.body.id;
    const res = await h.api.patch(`/v1/admin/gifts/${id}`).set(as).send({ active: false });
    expect(res.status).toBe(200);
    const list = await h.api.get('/v1/admin/gifts').set(as);
    expect(list.body.items.find((g: { id: string }) => g.id === id)).toMatchObject({
      active: false,
      animationUrl: 'https://cdn.test/admin/gifts/animations/dragon.svga',
      animationFormat: 'svga',
      category: 'luxury',
      sortOrder: 7,
      vipTierRequired: 2,
    });
  });

  it('suspending an agency keeps its logo', async () => {
    const as = h.as('fin', 'finance');
    await h.user('agency-owner');
    const created = await h.api.post('/v1/admin/agencies').set(as).send({
      name: 'Stars',
      ownerId: 'agency-owner',
      commissionRate: 0.05,
      logoUrl: 'https://cdn.test/admin/agencies/fin/stars.png',
    });
    expect(created.status).toBe(201);
    const id = created.body.agency._id;
    const res = await h.api.patch(`/v1/admin/agencies/${id}`).set(as).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect(res.body.agency).toMatchObject({
      status: 'suspended',
      logoUrl: 'https://cdn.test/admin/agencies/fin/stars.png',
    });
  });
});
