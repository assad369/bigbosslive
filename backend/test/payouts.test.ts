import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.ctx.services.config.set('economy', { minWithdrawBeans: 1000, beansPerUsd: 100 }, 'test');
  await h.user('host', { wallet: { beans: 10_000 } });
  await h.user('fin', { adminRole: 'finance' });
});
afterAll(async () => h.close());

const request = (beans: number, k = key()) =>
  h.api
    .post('/v1/withdrawals')
    .set(h.as('host'))
    .set('Idempotency-Key', k)
    .send({
      beans,
      method: 'mobile_wallet',
      account: { provider: 'bKash', number: '01700000000' },
    });

describe('withdrawals', () => {
  let id: string;

  it('holds beans immediately and allows one pending request', async () => {
    expect((await request(500)).status).toBe(400); // below minimum
    const res = await request(4000);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ beans: 4000, amountUsd: 40, status: 'pending' });
    id = res.body.id;
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.wallet.beans).toBe(6000);
    const second = await request(1000);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('withdrawal_pending');
  });

  it('never exposes payout account details in the user list', async () => {
    const mine = await h.api.get('/v1/withdrawals').set(h.as('host'));
    expect(mine.body.items[0].account).toBeUndefined();
  });

  it('rejecting releases the hold exactly once', async () => {
    const r1 = await h.api
      .post(`/v1/admin/withdrawals/${id}/review`)
      .set(h.as('fin', 'finance'))
      .send({ action: 'reject', note: 'wrong number' });
    expect(r1.status).toBe(200);
    const r2 = await h.api
      .post(`/v1/admin/withdrawals/${id}/review`)
      .set(h.as('fin', 'finance'))
      .send({ action: 'reject' });
    expect(r2.status).toBe(404);
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.wallet.beans).toBe(10_000);
    const note = await h.ctx.col.notifications.findOne({ userId: 'host', type: 'withdrawal' });
    expect(note!.body).toContain('wrong number');
  });

  it('approve → paid keeps the beans out', async () => {
    const res = await request(2000);
    await h.api
      .post(`/v1/admin/withdrawals/${res.body.id}/review`)
      .set(h.as('fin', 'finance'))
      .send({ action: 'mark_paid' })
      .expect(404); // must approve first
    await h.api
      .post(`/v1/admin/withdrawals/${res.body.id}/review`)
      .set(h.as('fin', 'finance'))
      .send({ action: 'approve' })
      .expect(200);
    const paid = await h.api
      .post(`/v1/admin/withdrawals/${res.body.id}/review`)
      .set(h.as('fin', 'finance'))
      .send({ action: 'mark_paid' });
    expect(paid.body.withdrawal.status).toBe('paid');
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.wallet.beans).toBe(8000);
  });
});

describe('host agencies', () => {
  it('owner approves applications and the monthly reset archives each period once', async () => {
    await h.user('owner');
    await h.user('member');
    const agency = await h.ctx.services.agencies.create(
      { name: 'Royal', owner: 'owner', logoUrl: null, commissionRate: 0.05 },
      'fin',
    );
    await h.api.post(`/v1/agencies/${agency._id}/join`).set(h.as('member')).expect(202);
    const reqs = await h.api.get('/v1/agencies/mine/requests').set(h.as('owner'));
    expect(reqs.body.items).toHaveLength(1);
    await h.api
      .post(`/v1/agencies/mine/requests/${reqs.body.items[0].id}`)
      .set(h.as('owner'))
      .send({ approve: true })
      .expect(204);
    expect((await h.ctx.col.agencies.findOne({ _id: agency._id }))!.memberCount).toBe(1);

    const now = h.ctx.clock.now();
    await h.ctx.services.agencies.recordLiveTime(
      agency._id,
      'member',
      new Date(now.getTime() - 3600_000),
      now,
    );
    await h.ctx.db.withTransaction((s) =>
      h.ctx.services.agencies.recordEarnings(s, {
        agencyId: agency._id,
        userId: 'member',
        beans: 700,
        commission: 35,
        gifts: 1,
        periodKey: h.ctx.services.agencies.currentPeriodKey(),
        at: now,
      }),
    );
    const before = await h.api.get('/v1/agencies/mine').set(h.as('owner'));
    expect(before.body.totals).toMatchObject({
      members: 1,
      periodBeans: 700,
      periodLiveSeconds: 3600,
      periodCommission: 35,
      lifetimeBeans: 700,
    });

    h.clock.set(new Date('2026-04-01T00:30:00Z'));
    expect(await h.ctx.services.agencies.monthlyReset()).toEqual({ rolled: 1 });
    expect(await h.ctx.services.agencies.monthlyReset()).toEqual({ rolled: 0 });
    const archived = await h.ctx.col.agencyPeriods.find({ agencyId: agency._id }).toArray();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ periodKey: '2026-03', beans: 700, liveSeconds: 3600 });
    const after = await h.api.get('/v1/agencies/mine').set(h.as('owner'));
    expect(after.body.totals.periodBeans).toBe(0);
  });

  it('a member removed from the agency decrements the count', async () => {
    await h.api.post('/v1/agencies/leave').set(h.as('member')).expect(204);
    const agency = await h.ctx.col.agencies.findOne({ ownerId: 'owner' });
    expect(agency!.memberCount).toBe(0);
    expect((await h.ctx.col.users.findOne({ _id: 'member' }))!.agencyId).toBeNull();
  });
});
