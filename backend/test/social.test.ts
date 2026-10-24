import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { filterText } from '../src/modules/moderation/textFilter.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  for (const uid of ['ann', 'ben', 'cat']) await h.user(uid);
});
afterAll(async () => h.close());

describe('text filter', () => {
  it('masks obfuscated profanity but not innocent words', () => {
    expect(filterText('you f.u.c.k').text).toBe('you *******');
    expect(filterText('sh1t happens').text).toBe('**** happens');
    expect(filterText('grapes and ball games').masked).toBe(false);
  });
  it('detects contact info', () => {
    expect(filterText('add me on whatsapp').contactInfo).toBe(true);
    expect(filterText('visit bigboss.xyz now').contactInfo).toBe(true);
    expect(filterText('gold gold gold').contactInfo).toBe(false);
  });
});

describe('follows', () => {
  it('keeps counters in sync and is idempotent', async () => {
    expect((await h.api.post('/v1/users/ben/follow').set(h.as('ann'))).body).toEqual({
      followed: true,
    });
    expect((await h.api.post('/v1/users/ben/follow').set(h.as('ann'))).body).toEqual({
      followed: false,
    });
    expect((await h.ctx.col.users.findOne({ _id: 'ben' }))!.stats.followers).toBe(1);
    const list = await h.api.get('/v1/users/ben/followers').set(h.as('cat'));
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual(['ann']);
    await h.api.delete('/v1/users/ben/follow').set(h.as('ann')).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'ann' }))!.stats.following).toBe(0);
  });

  it('blocking removes follows and prevents messaging', async () => {
    await h.api.post('/v1/users/cat/follow').set(h.as('ben')).expect(200);
    await h.api.post('/v1/users/ben/block').set(h.as('cat')).expect(204);
    expect((await h.ctx.col.users.findOne({ _id: 'cat' }))!.stats.followers).toBe(0);
    const dm = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ben'))
      .send({ toUserId: 'cat', type: 'text', text: 'hi' });
    expect(dm.status).toBe(403);
    await h.api.delete('/v1/users/ben/block').set(h.as('cat')).expect(204);
  });
});

describe('chat', () => {
  it('delivers, dedupes client retries, tracks unread and pushes', async () => {
    await h.ctx.services.notifications.registerToken('ben', 'fcm-token-ben-1234567890', 'android');
    const msg = { toUserId: 'ben', type: 'text', text: 'Hello boss', clientId: 'client-msg-0001' };
    const first = await h.api.post('/v1/chat/messages').set(h.as('ann')).send(msg);
    const retry = await h.api.post('/v1/chat/messages').set(h.as('ann')).send(msg);
    expect(first.status).toBe(201);
    expect(retry.body.message.id).toBe(first.body.message.id);
    await h.jobs.drain();
    expect(
      h.push.sent.some(
        (p) => p.tokens.includes('fcm-token-ben-1234567890') && p.message.body === 'Hello boss',
      ),
    ).toBe(true);

    expect((await h.api.get('/v1/chat/unread').set(h.as('ben'))).body.count).toBe(1);
    const convs = await h.api.get('/v1/chat/conversations').set(h.as('ben'));
    expect(convs.body.items[0]).toMatchObject({
      unread: 1,
      peer: { id: 'ann' },
      lastMessage: { text: 'Hello boss' },
    });
    await h.api
      .post(`/v1/chat/conversations/${convs.body.items[0].id}/read`)
      .set(h.as('ben'))
      .expect(204);
    expect((await h.api.get('/v1/chat/unread').set(h.as('ben'))).body.count).toBe(0);
    // Outsiders cannot read the thread.
    expect(
      (
        await h.api
          .get(`/v1/chat/conversations/${convs.body.items[0].id}/messages`)
          .set(h.as('cat'))
      ).status,
    ).toBe(404);
  });

  it('prunes push tokens FCM reports as invalid', async () => {
    h.push.invalid.add('fcm-token-ben-1234567890');
    await h.api
      .post('/v1/chat/messages')
      .set(h.as('ann'))
      .send({ toUserId: 'ben', type: 'text', text: 'again' });
    await h.jobs.drain();
    expect(await h.ctx.col.pushTokens.countDocuments({ userId: 'ben' })).toBe(0);
  });
});

describe('feed', () => {
  it('creates posts, counts likes idempotently and moderates text', async () => {
    const blocked = await h.api
      .post('/v1/feed')
      .set(h.as('ann'))
      .send({ text: 'dm me on telegram' });
    expect(blocked.status).toBe(422);
    const post = await h.api.post('/v1/feed').set(h.as('ann')).send({ text: 'Golden hour ✨' });
    expect(post.status).toBe(201);
    const id = post.body.post.id;
    await h.api.post(`/v1/feed/${id}/like`).set(h.as('ben')).expect(200);
    const again = await h.api.post(`/v1/feed/${id}/like`).set(h.as('ben'));
    expect(again.body.likeCount).toBe(1);
    await h.api
      .post(`/v1/feed/${id}/comments`)
      .set(h.as('cat'))
      .send({ text: 'Stunning' })
      .expect(201);
    const feed = await h.api.get('/v1/feed?tab=latest').set(h.as('ben'));
    expect(feed.body.items[0]).toMatchObject({
      id,
      likeCount: 1,
      commentCount: 1,
      likedByMe: true,
    });
    const trending = await h.api.get('/v1/feed?tab=trending').set(h.as('cat'));
    expect(trending.body.items[0].id).toBe(id);
    // Only the author (or an admin) can delete.
    expect((await h.api.delete(`/v1/feed/${id}`).set(h.as('ben'))).status).toBe(404);
    await h.api.delete(`/v1/feed/${id}`).set(h.as('ann')).expect(204);
  });
});

describe('notifications & announcements', () => {
  it('broadcasts an announcement to the inbox and push, with stats', async () => {
    await h.user('boss', { adminRole: 'admin' });
    await h.ctx.services.notifications.registerToken('cat', 'fcm-token-cat-1234567890', 'ios');
    const res = await h.api
      .post('/v1/admin/announcements')
      .set(h.as('boss', 'admin'))
      .send({ title: 'Gala night', body: 'Double beans this weekend' });
    expect(res.status).toBe(202);
    await h.jobs.drain();
    const ann = await h.ctx.col.announcements.findOne({});
    expect(ann!.status).toBe('sent');
    expect(ann!.stats.recipients).toBeGreaterThanOrEqual(4);
    const inbox = await h.api.get('/v1/notifications').set(h.as('cat'));
    expect(inbox.body.items.some((n: { title: string }) => n.title === 'Gala night')).toBe(true);
    // Re-running the job does not duplicate inbox rows.
    await h.ctx.col.announcements.updateOne({ _id: ann!._id }, { $set: { status: 'sending' } });
    await h.ctx.services.notifications.sendAnnouncement(ann!._id);
    expect(
      await h.ctx.col.notifications.countDocuments({ userId: 'cat', title: 'Gala night' }),
    ).toBe(1);
    await h.api.post('/v1/notifications/read').set(h.as('cat')).send({ ids: 'all' }).expect(204);
    expect(
      (await h.api.get('/v1/notifications/unread-count').set(h.as('cat'))).body.notifications,
    ).toBe(0);
  });

  it('reports are de-duplicated while open', async () => {
    const r1 = await h.api
      .post('/v1/reports')
      .set(h.as('ann'))
      .send({ targetType: 'user', targetId: 'cat', reason: 'spam' });
    expect(r1.status).toBe(201);
    const r2 = await h.api
      .post('/v1/reports')
      .set(h.as('ann'))
      .send({ targetType: 'user', targetId: 'cat', reason: 'spam' });
    expect(r2.status).toBe(409);
  });
});

describe('account deletion', () => {
  it('anonymises the profile and deletes the Firebase user', async () => {
    await h.user('leaver', { displayName: 'Leaving Soon' });
    await h.api.post('/v1/users/leaver/follow').set(h.as('ann')).expect(200);
    await h.api.delete('/v1/me').set(h.as('leaver')).expect(204);
    const doc = await h.ctx.col.users.findOne({ _id: 'leaver' });
    expect(doc).toMatchObject({ status: 'deleted', displayName: 'Deleted user', email: null });
    expect(h.auth.deleted).toContain('leaver');
    expect((await h.ctx.col.users.findOne({ _id: 'ann' }))!.stats.following).toBe(0);
    expect((await h.api.get('/v1/me').set(h.as('leaver'))).status).toBe(401);
  });
});
