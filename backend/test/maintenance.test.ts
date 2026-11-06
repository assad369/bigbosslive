import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('tester', { shortId: '777' });
  await h.user('qa');
  await h.user('public');
});
afterAll(async () => h.close());

const ADMIN = () => h.as('boss', 'admin');
const setMaintenance = (on: boolean) =>
  h.ctx.services.config.set(
    'app',
    { maintenance: on, maintenanceMessage: on ? 'Back at noon' : '' },
    'boss',
  );

describe('maintenance access list', () => {
  it('requires config.manage', async () => {
    const as = h.as('fin', 'finance');
    expect((await h.api.get('/v1/admin/maintenance/access').set(as)).status).toBe(403);
    const add = await h.api
      .post('/v1/admin/maintenance/access')
      .set(as)
      .send({ users: ['777'] });
    expect(add.status).toBe(403);
  });

  it('adds users by short id or uid and reports unknown ids', async () => {
    const res = await h.api
      .post('/v1/admin/maintenance/access')
      .set(ADMIN())
      .send({ users: ['777', 'qa', '99999', '777'] });
    expect(res.status).toBe(200);
    expect(res.body.added.map((u: { id: string }) => u.id)).toEqual(['tester', 'qa']);
    expect(res.body.notFound).toEqual(['99999']);

    // Adding again is a no-op.
    const again = await h.api
      .post('/v1/admin/maintenance/access')
      .set(ADMIN())
      .send({ users: ['qa'] });
    expect(again.body).toEqual({ added: [], notFound: [] });

    const list = await h.api.get('/v1/admin/maintenance/access').set(ADMIN());
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual(['tester', 'qa']);
    expect(await h.ctx.col.auditLogs.countDocuments({ action: 'maintenance.access_add' })).toBe(2);
  });

  it('flags listed users on /me whether or not maintenance is on', async () => {
    const tester = await h.api.get('/v1/me').set(h.as('tester'));
    expect(tester.body.user.maintenanceAccess).toBe(true);
    const other = await h.api.get('/v1/me').set(h.as('public'));
    expect(other.body.user.maintenanceAccess).toBe(false);
  });

  it('lets only listed users through while maintenance is on', async () => {
    await setMaintenance(true);
    try {
      expect((await h.api.get('/v1/me').set(h.as('tester'))).status).toBe(200);
      expect((await h.api.get('/v1/banners').set(h.as('qa'))).status).toBe(200);

      for (const path of ['/v1/me', '/v1/banners']) {
        const res = await h.api.get(path).set(h.as('public'));
        expect(res.status).toBe(503);
        expect(res.body.error).toMatchObject({ code: 'maintenance', message: 'Back at noon' });
      }
      const session = await h.api.post('/v1/auth/session').set(h.as('newbie')).send({});
      expect(session.status).toBe(503);
      expect(await h.ctx.col.users.findOne({ _id: 'newbie' })).toBeNull();

      // Staff keep the dashboard; in the app they are not on the list.
      const staff = await h.api.post('/v1/auth/session').set(ADMIN()).send({});
      expect(staff.status).toBe(200);
      expect(staff.body.user.maintenanceAccess).toBe(false);
      expect((await h.api.get('/v1/admin/maintenance/access').set(ADMIN())).status).toBe(200);
      expect((await h.api.get('/v1/me').set(ADMIN())).status).toBe(503);

      // The public config still answers and never carries the list.
      const cfg = await h.api.get('/v1/config/app');
      expect(cfg.status).toBe(200);
      expect(cfg.body.app.maintenance).toBe(true);
      expect(JSON.stringify(cfg.body)).not.toContain('tester');
    } finally {
      await setMaintenance(false);
    }
  });

  it('removing a user closes the app to them again', async () => {
    const del = await h.api.delete('/v1/admin/maintenance/access/qa').set(ADMIN());
    expect(del.status).toBe(204);
    expect(
      await h.ctx.col.auditLogs.findOne({ action: 'maintenance.access_remove', targetId: 'qa' }),
    ).toBeTruthy();

    await setMaintenance(true);
    try {
      expect((await h.api.get('/v1/me').set(h.as('qa'))).status).toBe(503);
      expect((await h.api.get('/v1/me').set(h.as('tester'))).status).toBe(200);
    } finally {
      await setMaintenance(false);
    }
    expect((await h.api.get('/v1/me').set(h.as('qa'))).status).toBe(200);
    expect((await h.api.get('/v1/me').set(h.as('public'))).status).toBe(200);
  });
});
