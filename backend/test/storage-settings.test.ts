import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketCorsRules } from '../src/infra/storage.js';
import { createHarness, fakeStorage, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('guesser', { adminRole: 'admin' });
  await h.user('ops', { adminRole: 'admin' });
});
afterAll(async () => h.close());

const PASSCODE = { 'X-Admin-Passcode': '9797' };
const SECRET = 'super-secret-r2-key-0123456789abcdef';
const settings = {
  accountId: '0123456789abcdef0123456789abcdef',
  bucket: 'bigboss-media',
  accessKeyId: 'r2-access-key',
  secretAccessKey: SECRET,
  publicBaseUrl: 'https://media.bigbosslive.app/',
};

describe('storage settings', () => {
  it('requires config.manage and the passcode', async () => {
    expect((await h.api.get('/v1/admin/storage').set(h.as('boss', 'admin'))).status).toBe(403);
    const wrong = await h.api
      .get('/v1/admin/storage')
      .set({ ...h.as('boss', 'admin'), 'X-Admin-Passcode': '0000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.message).toBe('Incorrect passcode');
    const fin = await h.api
      .get('/v1/admin/storage')
      .set({ ...h.as('fin', 'finance'), ...PASSCODE });
    expect(fin.status).toBe(403);
  });

  it('allows the passcode header in CORS preflight', async () => {
    const res = await h.api.options('/v1/admin/storage').set({
      Origin: 'https://admin.example.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,x-admin-passcode',
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Admin-Passcode/i);
  });

  it('falls back to env until settings are saved', async () => {
    const res = await h.api.get('/v1/admin/storage').set({ ...h.as('boss', 'admin'), ...PASSCODE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', secretSet: false, secretHint: null });
    expect(await h.ctx.services.storageSettings.resolve()).toBeNull();
  });

  it('saves settings without ever returning or auditing the secret', async () => {
    const as = { ...h.as('boss', 'admin'), ...PASSCODE };
    const saved = await h.api.put('/v1/admin/storage').set(as).send(settings);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      source: 'database',
      bucket: 'bigboss-media',
      publicBaseUrl: 'https://media.bigbosslive.app',
      secretSet: true,
      secretHint: '••••cdef',
    });
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);
    expect(JSON.stringify((await h.api.get('/v1/admin/storage').set(as)).body)).not.toContain(
      SECRET,
    );

    const audit = await h.ctx.col.auditLogs.findOne({ action: 'storage.update' });
    expect(audit?.payload).toMatchObject({ secretChanged: true, bucket: 'bigboss-media' });
    expect(JSON.stringify(audit)).not.toContain(SECRET);

    expect(await h.ctx.services.storageSettings.resolve()).toMatchObject({
      endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      secretAccessKey: SECRET,
    });

    // The generic config listing never carries storage credentials.
    const config = await h.api.get('/v1/admin/config').set(h.as('boss', 'admin'));
    expect(config.body.storage).toBeUndefined();
    expect(JSON.stringify(config.body)).not.toContain(SECRET);
  });

  it('keeps the stored secret when an update omits it', async () => {
    const as = { ...h.as('boss', 'admin'), ...PASSCODE };
    const { secretAccessKey: _omit, ...rest } = settings;
    const res = await h.api
      .put('/v1/admin/storage')
      .set(as)
      .send({ ...rest, bucket: 'bigboss-media-2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bucket: 'bigboss-media-2', secretHint: '••••cdef' });
    expect(await h.ctx.services.storageSettings.resolve()).toMatchObject({
      bucket: 'bigboss-media-2',
      secretAccessKey: SECRET,
    });
  });

  it('rejects malformed settings', async () => {
    const as = { ...h.as('boss', 'admin'), ...PASSCODE };
    const res = await h.api
      .put('/v1/admin/storage')
      .set(as)
      .send({ ...settings, accountId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('applies the bucket CORS rule for the configured origins', async () => {
    // Its own admin: the rejected calls below count toward the passcode lockout.
    const path = '/v1/admin/storage/cors';
    expect((await h.api.post(path).set(h.as('ops', 'admin'))).status).toBe(403);
    expect((await h.api.post(path).set({ ...h.as('fin', 'finance'), ...PASSCODE })).status).toBe(
      403,
    );

    const as = { ...h.as('ops', 'admin'), ...PASSCODE };
    const original = h.ctx.env.CORS_ORIGINS;
    try {
      h.ctx.env.CORS_ORIGINS = [];
      expect((await h.api.post(path).set(as)).status).toBe(400);

      h.ctx.env.CORS_ORIGINS = ['https://admin.example.com'];
      const res = await h.api.post(path).set(as);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, origins: ['https://admin.example.com'] });
      expect(fakeStorage.corsOrigins).toEqual(['https://admin.example.com']);
      expect(await h.ctx.col.auditLogs.findOne({ action: 'storage.cors' })).toBeTruthy();
    } finally {
      h.ctx.env.CORS_ORIGINS = original;
    }
  });

  it('builds a CORS rule that admits the signed upload headers', () => {
    expect(bucketCorsRules(['https://a.example'])).toEqual([
      expect.objectContaining({
        AllowedOrigins: ['https://a.example'],
        AllowedMethods: ['PUT', 'GET'],
        AllowedHeaders: ['Content-Type', 'Cache-Control'],
      }),
    ]);
  });

  it('tests the connection and reverts to env', async () => {
    const as = { ...h.as('boss', 'admin'), ...PASSCODE };
    expect((await h.api.post('/v1/admin/storage/test').set(as)).body).toEqual({ ok: true });
    const reset = await h.api.delete('/v1/admin/storage').set(as);
    expect(reset.status).toBe(200);
    expect(reset.body.source).toBe('none');
    expect(await h.ctx.services.storageSettings.resolve()).toBeNull();
  });

  it('locks out an admin after repeated wrong passcodes', async () => {
    const as = h.as('guesser', 'admin');
    for (let i = 0; i < 5; i++) {
      const res = await h.api.get('/v1/admin/storage').set({ ...as, 'X-Admin-Passcode': `${i}` });
      expect(res.status).toBe(403);
    }
    const locked = await h.api.get('/v1/admin/storage').set({ ...as, ...PASSCODE });
    expect(locked.status).toBe(429);
    // Other admins are unaffected.
    const other = await h.api
      .get('/v1/admin/storage')
      .set({ ...h.as('boss', 'admin'), ...PASSCODE });
    expect(other.status).toBe(200);
  });
});
