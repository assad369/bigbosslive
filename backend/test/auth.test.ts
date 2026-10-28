import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIRST_SHORT_ID } from '@bigboss/shared';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe('session bootstrap & auth', () => {
  it('rejects requests without a token', async () => {
    const res = await h.api.get('/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('requires a profile before other routes', async () => {
    const res = await h.api.get('/v1/me').set(h.as('nobody'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('profile_required');
  });

  it('creates the profile on first session, idempotently', async () => {
    const first = await h.api
      .post('/v1/auth/session')
      .set(h.as('alice'))
      .send({ displayName: 'Alice', country: 'bd' });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.user).toMatchObject({
      id: 'alice',
      displayName: 'Alice',
      country: 'BD',
      wallet: { diamonds: 0, beans: 0 },
    });
    // The first account on a fresh counter is numbered from FIRST_SHORT_ID.
    expect(first.body.user.shortId).toBe(String(FIRST_SHORT_ID));

    const again = await h.api.post('/v1/auth/session').set(h.as('alice')).send({});
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.user.shortId).toBe(first.body.user.shortId);
  });

  it('gives concurrent first sessions one profile', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => h.api.post('/v1/auth/session').set(h.as('racer')).send({})),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await h.ctx.col.users.countDocuments({ _id: 'racer' })).toBe(1);
  });

  it('masks profanity and rejects contact info in profile text', async () => {
    const bad = await h.api
      .patch('/v1/me')
      .set(h.as('alice'))
      .send({ bio: 'call me at +880 1711 223344' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('contact_info_blocked');
    const masked = await h.api.patch('/v1/me').set(h.as('alice')).send({ bio: 'what the fuck' });
    expect(masked.status).toBe(200);
    expect(masked.body.user.bio).toBe('what the ****');
  });

  it('blocks banned accounts until the ban expires', async () => {
    await h.user('bob');
    await h.ctx.services.users.ban('bob', {
      reason: 'spam',
      until: new Date(h.clock.now().getTime() + 3600_000),
      by: 'admin',
    });
    const banned = await h.api.get('/v1/me').set(h.as('bob'));
    expect(banned.status).toBe(403);
    expect(banned.body.error.code).toBe('account_banned');
    expect(h.auth.revoked).toContain('bob');

    h.clock.advance(3601);
    const ok = await h.api.get('/v1/me').set(h.as('bob'));
    expect(ok.status).toBe(200);
    expect(ok.body.user.status).toBe('active');
  });

  it('enforces device bans', async () => {
    await h.user('carol');
    await h.ctx.services.moderation.banDevice('device-abc123', {
      reason: 'fraud',
      by: 'admin',
      cascade: false,
    });
    const res = await h.api.get('/v1/me').set(h.as('carol')).set('X-Device-Id', 'DEVICE-ABC123');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('device_banned');
  });

  it('validates bodies with a structured error', async () => {
    const res = await h.api.patch('/v1/me').set(h.as('alice')).send({ displayName: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details[0].path).toBe('displayName');
  });

  it('serves the OpenAPI document in non-production', async () => {
    const res = await h.api.get('/docs/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('openapi: 3.1.0');
  });

  it('returns JSON 404 for unknown routes and malformed JSON as 400', async () => {
    expect((await h.api.get('/v1/nope')).body.error.code).toBe('route_not_found');
    const bad = await h.api
      .patch('/v1/me')
      .set(h.as('alice'))
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });
});

describe('admin RBAC', () => {
  beforeAll(async () => {
    await h.user('sup', { adminRole: 'support' });
    await h.user('fin', { adminRole: 'finance' });
    await h.user('root', { adminRole: 'superadmin' });
    await h.user('target');
  });

  it('rejects non-admins', async () => {
    expect((await h.api.get('/v1/admin/me').set(h.as('target'))).status).toBe(403);
  });

  it('uses the token claim, not the Mongo mirror', async () => {
    // Mongo says admin, but the verified token carries no claim.
    await h.user('mirror-only', { adminRole: 'admin' });
    expect((await h.api.get('/v1/admin/me').set(h.as('mirror-only'))).status).toBe(403);
  });

  it('applies the permission matrix', async () => {
    const supMe = await h.api.get('/v1/admin/me').set(h.as('sup', 'support'));
    expect(supMe.body.permissions).toContain('users.read');
    expect(supMe.body.permissions).not.toContain('wallet.adjust');

    const denied = await h.api
      .post('/v1/admin/users/target/wallet/adjust')
      .set(h.as('sup', 'support'))
      .send({ currency: 'diamonds', delta: 100, note: 'test' });
    expect(denied.status).toBe(403);

    const ok = await h.api
      .post('/v1/admin/users/target/wallet/adjust')
      .set(h.as('fin', 'finance'))
      .send({ currency: 'diamonds', delta: 100, note: 'goodwill' });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(100);

    const audit = await h.ctx.col.auditLogs.findOne({
      action: 'wallet.adjust',
      targetId: 'target',
    });
    expect(audit).toMatchObject({ adminId: 'fin', adminRole: 'finance' });
  });

  it('only superadmins manage admin roles', async () => {
    expect(
      (
        await h.api
          .post('/v1/admin/admins')
          .set(h.as('fin', 'finance'))
          .send({ uid: 'target', role: 'support' })
      ).status,
    ).toBe(403);
    const res = await h.api
      .post('/v1/admin/admins')
      .set(h.as('root', 'superadmin'))
      .send({ uid: 'target', role: 'moderator' });
    expect(res.status).toBe(204);
    expect(h.auth.roles.get('target')).toBe('moderator');
  });
});
