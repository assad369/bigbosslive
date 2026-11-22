import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_TERMS_VERSION } from '@bigboss/shared';
import { ageOn } from '../src/modules/users/age.js';
import { createHarness, fakeStorage, key, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('adm', { adminRole: 'admin' });
});
afterAll(async () => h.close());

const yearsAgo = (years: number, days = 0) => {
  const now = h.clock.now();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
};
const img = (uid: string, folder: string) => `https://cdn.test/${folder}/${uid}/${key()}.webp`;

describe('age', () => {
  it('counts whole years by calendar date', () => {
    const born = new Date('2008-06-15T00:00:00Z');
    expect(ageOn(born, new Date('2026-06-14T23:00:00Z'))).toBe(17);
    expect(ageOn(born, new Date('2026-06-15T00:00:00Z'))).toBe(18);
  });
});

describe('consent screen', () => {
  it('asks for a date of birth and the current terms until both are given', async () => {
    await h.user('new1', { birthday: null, termsAcceptedVersion: null });
    const before = await h.api.get('/v1/me').set(h.as('new1'));
    expect(before.body.user).toMatchObject({ needsConsent: true, birthday: null });

    const missing = await h.api
      .post('/v1/me/consent')
      .set(h.as('new1'))
      .send({ termsVersion: CURRENT_TERMS_VERSION });
    expect(missing.body.error.code).toBe('birthday_required');
    const stale = await h.api
      .post('/v1/me/consent')
      .set(h.as('new1'))
      .send({ termsVersion: '2000-01-01', birthday: yearsAgo(30) });
    expect(stale.status).toBe(409);

    const ok = await h.api
      .post('/v1/me/consent')
      .set(h.as('new1'))
      .send({ termsVersion: CURRENT_TERMS_VERSION, birthday: yearsAgo(30) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.needsConsent).toBe(false);
    expect(ok.body.user.birthday).toBe(`${yearsAgo(30)}T00:00:00.000Z`);

    // The date of birth is given once.
    const change = await h.api
      .patch('/v1/me')
      .set(h.as('new1'))
      .send({ birthday: yearsAgo(40) });
    expect(change.body.error.code).toBe('birthday_locked');
  });

  it('locks an account that gives an under-18 date, for good, but lets it delete itself', async () => {
    await h.user('kid', { birthday: null, termsAcceptedVersion: null });
    const res = await h.api
      .post('/v1/me/consent')
      .set(h.as('kid'))
      .send({ termsVersion: CURRENT_TERMS_VERSION, birthday: yearsAgo(18, 1) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('underage');

    // Every other route refuses, and a second, adult date doesn't lift it.
    expect((await h.api.get('/v1/me').set(h.as('kid'))).body.error.code).toBe('underage');
    const retry = await h.api
      .post('/v1/me/consent')
      .set(h.as('kid'))
      .send({ termsVersion: CURRENT_TERMS_VERSION, birthday: yearsAgo(30) });
    expect(retry.body.error.code).toBe('underage');
    expect((await h.api.post('/v1/auth/session').set(h.as('kid'))).body.error.code).toBe(
      'underage',
    );

    await h.api.delete('/v1/me').set(h.as('kid')).expect(204);
    expect((await h.ctx.col.users.findOne({ _id: 'kid' }))!.status).toBe('deleted');
  });

  it('accepts exactly 18 and refuses an under-18 date at signup', async () => {
    await h.user('adult18', { birthday: null, termsAcceptedVersion: null });
    await h.api
      .post('/v1/me/consent')
      .set(h.as('adult18'))
      .send({ termsVersion: CURRENT_TERMS_VERSION, birthday: yearsAgo(18) })
      .expect(200);
    const signup = await h.api
      .post('/v1/auth/session')
      .set(h.as('minor'))
      .send({ birthday: yearsAgo(15) });
    expect(signup.body.error.code).toBe('underage');
    expect(await h.ctx.col.users.findOne({ _id: 'minor' })).toBeNull();
  });

  it('keeps games and withdrawals for adults with a stated date of birth', async () => {
    await h.user('nodob', { birthday: null, wallet: { diamonds: 100_000 } });
    const res = await h.api
      .post('/v1/withdrawals')
      .set(h.as('nodob'))
      .set('Idempotency-Key', key())
      .send({ diamonds: 60_000, method: 'paypal', account: { email: 'a@b.co' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('age_required');
  });
});

describe('inbox messages', () => {
  beforeAll(async () => {
    await h.user('ann');
    await h.user('ben');
  });

  it('refuses a text message carrying a mediaUrl (it would skip the image check)', async () => {
    const res = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ann'))
      .send({ toUserId: 'ben', type: 'text', text: 'hi', mediaUrl: img('ann', 'chat') });
    expect(res.status).toBe(422); // schema validation
  });

  it("refuses a photo that isn't the sender's own chat upload", async () => {
    const res = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ann'))
      .send({ toUserId: 'ben', type: 'image', mediaUrl: img('ben', 'chat') });
    expect(res.status).toBe(400);
    const ok = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ann'))
      .send({ toUserId: 'ben', type: 'image', mediaUrl: img('ann', 'chat') });
    expect(ok.status).toBe(201);
  });
});

describe('reports', () => {
  beforeAll(async () => {
    await h.user('rep');
    await h.user('bad');
    await h.user('other');
  });

  it('makes child-safety reports urgent, first in the queue, with a snapshot', async () => {
    const dm = await h.api
      .post('/v1/chat/messages')
      .set(h.as('bad'))
      .send({ toUserId: 'rep', type: 'text', text: 'something awful' });
    const messageId = dm.body.message.id as string;
    await h.api
      .post('/v1/reports')
      .set(h.as('rep'))
      .send({ targetType: 'user', targetId: 'other', reason: 'spam' })
      .expect(201);
    const res = await h.api
      .post('/v1/reports')
      .set(h.as('rep'))
      // Older apps send `message` for any chat message.
      .send({ targetType: 'message', targetId: messageId, reason: 'child_safety' });
    expect(res.status).toBe(201);

    const stored = await h.ctx.col.reports.findOne({ _id: new ObjectId(res.body.id as string) });
    expect(stored).toMatchObject({
      targetType: 'dm',
      priority: 'urgent',
      snapshot: { authorId: 'bad', text: 'something awful', mediaUrl: null },
    });

    const list = await h.api.get('/v1/admin/reports?status=open').set(h.as('adm', 'admin'));
    expect(list.body.urgentOpen).toBe(1);
    expect(list.body.items[0]).toMatchObject({ reason: 'child_safety', priority: 'urgent' });
    expect(list.body.items[0].author.id).toBe('bad');
    expect(await h.ctx.col.auditLogs.findOne({ action: 'report.child_safety' })).not.toBeNull();
  });

  it('takes a general safety concern from Settings, details required', async () => {
    const short = await h.api
      .post('/v1/reports')
      .set(h.as('rep'))
      .send({ targetType: 'concern', targetId: key(), reason: 'child_safety', details: 'hm' });
    expect(short.status).toBe(400);
    const ok = await h.api.post('/v1/reports').set(h.as('rep')).send({
      targetType: 'concern',
      targetId: key(),
      reason: 'child_safety',
      details: 'A user keeps asking for photos of children',
    });
    expect(ok.status).toBe(201);
  });

  it("doesn't copy an inbox message for someone outside the conversation", async () => {
    const dm = await h.api
      .post('/v1/chat/messages')
      .set(h.as('bad'))
      .send({ toUserId: 'rep', type: 'text', text: 'private words' });
    await h.api
      .post('/v1/reports')
      .set(h.as('other'))
      .send({ targetType: 'dm', targetId: dm.body.message.id, reason: 'harassment' })
      .expect(201);
    const stored = await h.ctx.col.reports.findOne({ reporterId: 'other', targetType: 'dm' });
    expect(stored!.snapshot).toBeNull();
  });
});

describe('account deletion', () => {
  it('lets a banned user delete, and erases messages, posts and uploads', async () => {
    await h.user('gone', { status: 'banned' });
    await h.ctx.col.users.updateOne(
      { _id: 'gone' },
      { $set: { ban: { reason: 'spam', until: null, by: 'adm', at: h.clock.now() } } },
    );
    await h.user('friend');
    await h.ctx.col.devices.insertOne({
      userId: 'gone',
      deviceId: 'dev-gone-1',
      platform: 'android',
      firstSeenAt: h.clock.now(),
      lastSeenAt: h.clock.now(),
    });
    const conversation = new ObjectId();
    await h.ctx.col.conversations.insertOne({
      _id: conversation,
      key: 'friend:gone',
      participants: ['friend', 'gone'],
      lastMessage: { text: 'my secret', senderId: 'gone', type: 'text', at: h.clock.now() },
      unread: {},
      updatedAt: h.clock.now(),
      createdAt: h.clock.now(),
    });
    await h.ctx.col.messages.insertOne({
      _id: new ObjectId(),
      conversationId: conversation,
      senderId: 'gone',
      type: 'image',
      text: 'my secret',
      mediaUrl: img('gone', 'chat'),
      clientId: null,
      deletedFor: [],
      createdAt: h.clock.now(),
    });
    const post = new ObjectId();
    await h.ctx.col.feedPosts.insertOne({
      _id: post,
      authorId: 'friend',
      text: 'hello',
      media: [],
      likeCount: 1,
      commentCount: 1,
      status: 'active',
      score: 0,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });
    await h.ctx.col.feedComments.insertOne({
      _id: new ObjectId(),
      postId: post,
      authorId: 'gone',
      text: 'a comment',
      status: 'active',
      createdAt: h.clock.now(),
    });
    await h.ctx.col.feedLikes.insertOne({ postId: post, userId: 'gone', createdAt: h.clock.now() });

    await h.api.delete('/v1/me').set(h.as('gone')).expect(204);
    await h.jobs.drain();

    const user = (await h.ctx.col.users.findOne({ _id: 'gone' }))!;
    expect(user).toMatchObject({ status: 'deleted', country: null, birthday: null });
    expect(await h.ctx.col.messages.findOne({ senderId: 'gone' })).toMatchObject({
      text: null,
      mediaUrl: null,
    });
    expect((await h.ctx.col.conversations.findOne({ _id: conversation }))!.lastMessage!.text).toBe(
      '',
    );
    expect(await h.ctx.col.feedPosts.findOne({ _id: post })).toMatchObject({
      likeCount: 0,
      commentCount: 0,
    });
    expect(await h.ctx.col.feedComments.findOne({ authorId: 'gone' })).toMatchObject({
      status: 'removed',
      text: '',
    });
    // A banned account's devices stay, against ban evasion.
    expect(await h.ctx.col.devices.countDocuments({ userId: 'gone' })).toBe(1);
    expect(h.auth.deleted).toContain('gone');
    expect(fakeStorage.erased.at(-1)).toMatchObject({ ownerId: 'gone' });
    expect(fakeStorage.erased.at(-1)!.folders).toContain('chat');
  });

  it('keeps media an urgent report holds as evidence', async () => {
    await h.user('suspect');
    await h.user('witness');
    const evidence = img('suspect', 'chat');
    const sent = await h.api
      .post('/v1/chat/messages')
      .set(h.as('suspect'))
      .send({ toUserId: 'witness', type: 'image', mediaUrl: evidence });
    await h.api
      .post('/v1/reports')
      .set(h.as('witness'))
      .send({ targetType: 'dm', targetId: sent.body.message.id, reason: 'child_safety' })
      .expect(201);
    await h.api.delete('/v1/me').set(h.as('suspect')).expect(204);
    await h.jobs.drain();
    expect(fakeStorage.erased.at(-1)).toMatchObject({ ownerId: 'suspect', keep: [evidence] });
  });

  it('waits for a pending withdrawal', async () => {
    await h.user('payee');
    await h.ctx.col.withdrawals.insertOne({
      _id: new ObjectId(),
      userId: 'payee',
      diamonds: 1000,
      amountUsd: 1,
      method: 'paypal',
      account: {},
      status: 'pending',
      idempotencyKey: `payee:${key()}`,
      note: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: h.clock.now(),
    });
    const res = await h.api.delete('/v1/me').set(h.as('payee'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('withdrawal_pending');
  });

  it('takes requests from the web page and lets staff delete the matched account', async () => {
    const webUser = await h.user('webuser');
    await h.ctx.col.users.updateOne({ _id: 'webuser' }, { $set: { email: 'web@example.com' } });
    const res = await h.api
      .post('/v1/account-deletion-requests')
      .send({ contact: 'web@example.com', reason: 'leaving' });
    expect(res.status).toBe(202);
    // The answer is the same whether or not anything matches.
    const unknown = await h.api
      .post('/v1/account-deletion-requests')
      .send({ contact: 'nobody@example.com' });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(res.body);

    const list = await h.api
      .get('/v1/admin/deletion-requests?status=pending')
      .set(h.as('adm', 'admin'));
    const row = list.body.items.find((x: { contact: string }) => x.contact === 'web@example.com');
    expect(row).toBeDefined();
    const done = await h.api
      .post(`/v1/admin/deletion-requests/${row._id}/resolve`)
      .set(h.as('adm', 'admin'))
      .send({ action: 'delete', user: webUser.shortId });
    expect(done.status).toBe(200);
    expect(done.body.request).toMatchObject({ status: 'done', resolvedUid: 'webuser' });
    expect((await h.ctx.col.users.findOne({ _id: 'webuser' }))!.status).toBe('deleted');
    expect(await h.ctx.col.auditLogs.findOne({ action: 'account.deletion_delete' })).not.toBeNull();
  });
});
