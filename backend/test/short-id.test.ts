import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('viewer');
  await h.user('alice', { displayName: 'Alice' });
  await h.user('bob', { displayName: 'Bob' });
});
afterAll(async () => h.close());

const setShortId = (uid: string, shortId: string) =>
  h.api.post(`/v1/admin/users/${uid}/short-id`).set(h.as('boss', 'admin')).send({ shortId });

describe('admin short ids', () => {
  it('assigns a 1-digit id that lookups, search and share links resolve', async () => {
    expect((await setShortId('alice', '1')).status).toBe(204);
    expect((await h.ctx.col.users.findOne({ _id: 'alice' }))?.shortId).toBe('1');

    const profile = await h.api.get('/v1/users/1').set(h.as('viewer'));
    expect(profile.status).toBe(200);
    expect(profile.body.user).toMatchObject({ id: 'alice', shortId: '1' });

    const search = await h.api.get('/v1/users/search').query({ q: '1' }).set(h.as('viewer'));
    expect(search.status).toBe(200);
    expect(search.body.items.map((u: { id: string }) => u.id)).toContain('alice');

    const preview = await h.api.get('/v1/share/preview/user/1');
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ kind: 'user', user: { shortId: '1' } });
  });

  it('rejects 0, leading zeros, non-digits and more than 12 digits', async () => {
    for (const bad of ['0', '01', '007', '1a', '', '1'.repeat(13)]) {
      expect((await setShortId('bob', bad)).status, bad).toBe(400);
    }
    expect((await setShortId('bob', '9'.repeat(12))).status).toBe(204);
  });

  it('swaps when the 1-digit id is taken', async () => {
    const bobBefore = (await h.ctx.col.users.findOne({ _id: 'bob' }))!.shortId;
    expect((await setShortId('bob', '1')).status).toBe(204);
    const [alice, bob] = await Promise.all([
      h.ctx.col.users.findOne({ _id: 'alice' }),
      h.ctx.col.users.findOne({ _id: 'bob' }),
    ]);
    expect(bob?.shortId).toBe('1');
    expect(alice?.shortId).toBe(bobBefore);
  });
});
