import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let agencyId: string;
const admin = () => h.as('staff', 'finance');

beforeAll(async () => {
  h = await createHarness();
  await h.user('staff', { adminRole: 'finance' });
  await h.user('boss', { shortId: '201' });
  await h.user('host-a', { shortId: '202' });
  await h.user('host-b', { shortId: '203' });
  await h.user('host-c', { shortId: '204' });
  await h.user('rival-boss', { shortId: '205' });
});
afterAll(async () => h.close());

describe('admin creates agencies by owner short id', () => {
  it('resolves the owner, assigns a code and refuses duplicate or member owners', async () => {
    const lookup = await h.api.get('/v1/admin/users/lookup?q=201').set(admin());
    expect(lookup.body).toMatchObject({ user: { id: 'boss' }, ownsAgencyId: null });

    const res = await h.api
      .post('/v1/admin/agencies')
      .set(admin())
      .send({ name: 'Crown', owner: '201', logoUrl: null, commissionRate: 0.05 });
    expect(res.status).toBe(201);
    expect(res.body.agency).toMatchObject({ ownerId: 'boss', memberCount: 0 });
    expect(res.body.agency.code).toMatch(/^HA-[A-Z2-9]{8}$/);
    agencyId = res.body.agency._id;

    const again = await h.api
      .post('/v1/admin/agencies')
      .set(admin())
      .send({ name: 'Crown 2', owner: '201', logoUrl: null, commissionRate: 0.05 });
    expect(again.status).toBe(409);

    await h.api
      .post(`/v1/admin/agencies/${agencyId}/members`)
      .set(admin())
      .send({ user: '204' })
      .expect(204);
    const memberOwner = await h.api
      .post('/v1/admin/agencies')
      .set(admin())
      .send({ name: 'Nope', owner: '204', logoUrl: null, commissionRate: 0.05 });
    expect(memberOwner.status).toBe(409);
  });

  it('a new agency shows in the top slider straight away, ranked by month beans', async () => {
    const rival = await h.api
      .post('/v1/admin/agencies')
      .set(admin())
      .send({ name: 'Rival', owner: '205', logoUrl: null, commissionRate: 0.05 });
    const top = await h.api.get('/v1/agencies/top').set(h.as('host-a'));
    expect(top.body.items.map((a: { name: string }) => a.name)).toEqual(['Crown', 'Rival']);
    expect(top.body.items[1]).toMatchObject({ rank: 2, periodBeans: 0, memberCount: 0 });

    const rivalId = rival.body.agency._id as string;
    await h.ctx.db.withTransaction((s) =>
      h.ctx.services.agencies.recordEarnings(s, {
        agencyId: new ObjectId(rivalId),
        userId: 'nobody',
        beans: 999,
        commission: 0,
        gifts: 1,
        periodKey: h.ctx.services.agencies.currentPeriodKey(),
        at: h.ctx.clock.now(),
      }),
    );
    h.clock.advance(20); // past the ranking cache
    const after = await h.api.get('/v1/agencies/top').set(h.as('host-a'));
    expect(after.body.items[0]).toMatchObject({ name: 'Rival', rank: 1, periodBeans: 999 });

    await h.api
      .patch(`/v1/admin/agencies/${rivalId}`)
      .set(admin())
      .send({ status: 'suspended' })
      .expect(200);
    const suspended = await h.api.get('/v1/agencies/top').set(h.as('host-a'));
    expect(suspended.body.items.map((a: { name: string }) => a.name)).toEqual(['Crown']);
  });
});

describe('invitations need the host to accept', () => {
  it('invite → accept joins and cancels the host’s pending application', async () => {
    const rivalAgency = await h.ctx.col.agencies.findOne({ ownerId: 'boss' });
    await h.api.post(`/v1/agencies/${rivalAgency!._id}/join`).set(h.as('host-a')).expect(202);

    const inv = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '202' });
    expect(inv.status).toBe(201);
    const dup = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '202' });
    expect(dup.status).toBe(409);

    const mine = await h.api.get('/v1/agencies/invitations').set(h.as('host-a'));
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].agency.name).toBe('Crown');
    await h.api
      .post(`/v1/agencies/invitations/${mine.body.items[0].id}`)
      .set(h.as('host-a'))
      .send({ accept: true })
      .expect(204);

    const membership = await h.api.get('/v1/agencies/membership').set(h.as('host-a'));
    expect(membership.body.membership).toMatchObject({ role: 'host', locked: false });
    expect(
      await h.ctx.col.agencyRequests.countDocuments({ userId: 'host-a', status: 'pending' }),
    ).toBe(0);
    const memberAgain = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '202' });
    expect(memberAgain.status).toBe(409);
  });

  it('declined, cancelled and expired invitations do not join', async () => {
    const inv = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '203' });
    await h.api
      .delete(`/v1/agencies/mine/invitations/${inv.body.invitation.id}`)
      .set(h.as('boss'))
      .expect(204);
    expect((await h.api.get('/v1/agencies/invitations').set(h.as('host-b'))).body.items).toEqual(
      [],
    );

    const again = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '203' });
    expect(again.status).toBe(201);
    h.clock.advance(8 * 86_400);
    const late = await h.api
      .post(`/v1/agencies/invitations/${again.body.invitation.id}`)
      .set(h.as('host-b'))
      .send({ accept: true });
    expect(late.status).toBe(404);

    const fresh = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('boss'))
      .send({ target: '203' });
    expect(fresh.status).toBe(201);
    await h.api
      .post(`/v1/agencies/invitations/${fresh.body.invitation.id}`)
      .set(h.as('host-b'))
      .send({ accept: false })
      .expect(204);
    expect(await h.ctx.col.agencyMembers.countDocuments({ userId: 'host-b' })).toBe(0);
  });
});

describe('roles, lock and targets', () => {
  it('agency admins manage hosts but not owner-only settings', async () => {
    await h.api
      .post('/v1/agencies/mine/members/host-a/role')
      .set(h.as('boss'))
      .send({ role: 'admin' })
      .expect(204);
    const dash = await h.api.get('/v1/agencies/mine').set(h.as('host-a'));
    expect(dash.status).toBe(200);
    expect(dash.body.role).toBe('admin');

    expect(
      (await h.api.post('/v1/agencies/mine/members/host-c/lock').set(h.as('host-a'))).status,
    ).toBe(403);
    expect(
      (
        await h.api
          .put('/v1/agencies/mine/members/host-c/target')
          .set(h.as('host-a'))
          .send({ minutes: 60 })
      ).status,
    ).toBe(403);
    expect(
      (await h.api.patch('/v1/agencies/mine').set(h.as('host-a')).send({ name: 'Mine now' }))
        .status,
    ).toBe(403);

    const inv = await h.api
      .post('/v1/agencies/mine/invitations')
      .set(h.as('host-a'))
      .send({ target: '203' });
    expect(inv.status).toBe(201);
  });

  it('a locked host cannot leave until a platform admin unlocks them', async () => {
    await h.api.post('/v1/agencies/mine/members/host-c/lock').set(h.as('boss')).expect(204);
    const leave = await h.api.post('/v1/agencies/leave').set(h.as('host-c'));
    expect(leave.status).toBe(403);
    expect(leave.body.error.code).toBe('agency_locked');

    await h.api
      .post(`/v1/admin/agencies/${agencyId}/members/host-c/unlock`)
      .set(admin())
      .expect(204);
    await h.api.post('/v1/agencies/leave').set(h.as('host-c')).expect(204);
  });

  it('owners set daily targets and see today’s progress', async () => {
    await h.api
      .put('/v1/agencies/mine/members/host-a/target')
      .set(h.as('boss'))
      .send({ minutes: 90 })
      .expect(204);
    const members = await h.api.get('/v1/agencies/mine/members').set(h.as('boss'));
    expect(members.body.items[0]).toMatchObject({
      user: { id: 'host-a' },
      role: 'admin',
      dailyTargetMinutes: 90,
      todayLiveSeconds: 0,
    });
  });
});

describe('daily stats, analytics and the activity log', () => {
  it('splits live time across midnight and reports per-day analytics', async () => {
    h.clock.set(new Date('2026-04-10T12:00:00Z'));
    const agency = await h.ctx.col.agencies.findOne({ ownerId: 'boss' });
    await h.ctx.services.agencies.recordLiveTime(
      agency!._id,
      'host-a',
      new Date('2026-04-09T23:00:00Z'),
      new Date('2026-04-10T01:00:00Z'),
    );
    const days = await h.ctx.col.agencyDailyStats
      .find({ userId: 'host-a' })
      .sort({ dayKey: 1 })
      .toArray();
    expect(days.map((d) => [d.dayKey, d.liveSeconds])).toEqual([
      ['2026-04-09', 3600],
      ['2026-04-10', 3600],
    ]);

    const host = await h.api
      .get('/v1/agencies/mine/members/host-a/analytics?days=7')
      .set(h.as('boss'));
    expect(host.status).toBe(200);
    expect(host.body.daily).toHaveLength(7);
    expect(host.body.totals.liveSeconds).toBe(7200);
    expect(host.body.member.todayLiveSeconds).toBe(3600);

    const agencyStats = await h.api.get('/v1/agencies/mine/analytics?days=7').set(h.as('boss'));
    expect(agencyStats.body.daily.at(-1)).toMatchObject({ liveSeconds: 3600, activeHosts: 1 });

    const dash = await h.api.get('/v1/agencies/mine').set(h.as('boss'));
    expect(dash.body.totals).toMatchObject({ periodLiveSeconds: 7200, todayLiveSeconds: 3600 });
    expect(dash.body.rank).toBe(1);
  });

  it('owners edit name and logo; the logo must be their own upload', async () => {
    const bad = await h.api
      .patch('/v1/agencies/mine')
      .set(h.as('boss'))
      .send({ logoUrl: 'https://cdn.test/agency-logos/someone-else/x.png' });
    expect(bad.status).toBe(400);
    const ok = await h.api
      .patch('/v1/agencies/mine')
      .set(h.as('boss'))
      .send({ name: 'Crown Royal', logoUrl: 'https://cdn.test/agency-logos/boss/logo.png' });
    expect(ok.status).toBe(200);
    expect(ok.body.agency).toMatchObject({ name: 'Crown Royal' });
  });

  it('records every action in the activity log', async () => {
    const log = await h.api.get('/v1/agencies/mine/audit?limit=100').set(h.as('boss'));
    const actions = log.body.items.map((r: { action: string }) => r.action);
    for (const a of [
      'agency_created',
      'host_added',
      'request_submitted',
      'host_invited',
      'invite_accepted',
      'invite_cancelled',
      'invite_declined',
      'admin_promoted',
      'host_locked',
      'host_unlocked',
      'host_left',
      'target_updated',
      'agency_updated',
    ])
      expect(actions).toContain(a);
    expect((await h.api.get('/v1/agencies/mine/audit').set(h.as('host-b'))).status).toBe(403);
  });
});
