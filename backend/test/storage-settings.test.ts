import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('guesser', { adminRole: 'admin' });
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
