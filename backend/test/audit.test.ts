import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditLogDoc } from '../src/db/schema.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin', displayName: 'Boss', shortId: '301' });
  await h.user('fin', { adminRole: 'finance' });
  await h.user('host', { displayName: 'Host Person' });
  await h.user('viewer', { displayName: 'Viewer' });

  const row = (r: Partial<AuditLogDoc>): AuditLogDoc => ({
    adminId: 'boss',
    adminRole: 'admin',
    action: 'config.update',
    targetType: 'config',
    targetId: 'app',
    payload: null,
    ip: '127.0.0.1',
    createdAt: at('2026-11-01T10:00:00Z'),
    ...r,
  });
  await h.ctx.col.auditLogs.insertMany([
    row({
      action: 'wallet.adjust',
      targetType: 'user',
      targetId: 'viewer',
      payload: { currency: 'diamonds', delta: -500, note: 'refund' },
      createdAt: at('2026-11-02T10:00:00Z'),
    }),
    row({
      action: 'wallet.recharge',
      targetType: 'user',
      targetId: 'viewer',
      payload: { diamonds: 100, note: '' },
      createdAt: at('2026-11-03T10:00:00Z'),
    }),
    row({
      action: 'agency.add_member',
      targetType: 'agency',
      targetId: 'a1',
      payload: { userId: 'host' },
      createdAt: at('2026-11-04T10:00:00Z'),
    }),
    row({
      adminId: 'system',
      adminRole: 'system',
      action: 'sightguard.live.end',
      targetType: 'room',
      targetId: 'r1',
      payload: { hostId: 'host', reason: 'nudity' },
      ip: '',
      createdAt: at('2026-11-05T10:00:00Z'),
    }),
    row({ action: 'walletXadjust', createdAt: at('2026-11-06T10:00:00Z') }),
  ]);
});
afterAll(async () => h.close());

const ADMIN = () => h.as('boss', 'admin');
const list = (query: Record<string, string> = {}) =>
  h.api.get('/v1/admin/audit').query(query).set(ADMIN());

describe('audit log list', () => {
  it('names the actor and the user an entry is about', async () => {
    const res = await h.api
      .post('/v1/admin/users/host/ban')
      .set(ADMIN())
      .send({ reason: 'spam spam', days: 7 });
    expect(res.status).toBe(204);

    const { body } = await list({ action: 'user.ban' });
    expect(body.total).toBe(1);
    const [entry] = body.items;
    expect(entry.payload).toEqual({ reason: 'spam spam', days: 7 });
    expect(entry.actor).toMatchObject({ id: 'boss', displayName: 'Boss' });
    expect(entry.subject).toMatchObject({ id: 'host', displayName: 'Host Person' });
  });

  it('takes the subject from the payload for non-user targets', async () => {
    const member = (await list({ action: 'agency.add_member' })).body.items[0];
    expect(member.subject).toMatchObject({ id: 'host' });

    const system = (await list({ actorKind: 'system' })).body.items[0];
    expect(system.actor).toBeNull();
    expect(system.subject).toMatchObject({ id: 'host' });
  });

  it('filters by domain prefix, never as a raw regex', async () => {
    const { body } = await list({ domain: 'wallet' });
    expect(body.items.map((r: AuditLogDoc) => r.action).sort()).toEqual([
      'wallet.adjust',
      'wallet.recharge',
    ]);
    expect((await list({ domain: 'wallet.*' })).status).toBe(422);
  });

  it('filters by time range', async () => {
    const { body } = await list({
      from: '2026-11-02T00:00:00Z',
      to: '2026-11-04T23:59:59Z',
    });
    expect(body.items.map((r: AuditLogDoc) => r.action)).toEqual([
      'agency.add_member',
      'wallet.recharge',
      'wallet.adjust',
    ]);
  });

  it('accepts the actor as a short id or a uid', async () => {
    const byShort = await list({ adminId: '301', domain: 'wallet' });
    expect(byShort.body.total).toBe(2);
    const byUid = await list({ adminId: 'boss', domain: 'wallet' });
    expect(byUid.body.total).toBe(2);
    expect((await list({ adminId: '99999' })).body.total).toBe(0);
  });
});
