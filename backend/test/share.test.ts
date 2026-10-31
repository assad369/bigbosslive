import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('host', { displayName: 'Golden Host', shortId: '777' });
  await h.user('writer', { displayName: 'Writer', shortId: '778' });
  await h.user('gone', { shortId: '779', status: 'banned' });
});
afterAll(async () => h.close());

const preview = (kind: string, id: string) => h.api.get(`/v1/share/preview/${kind}/${id}`);

describe('share previews', () => {
  it('describes a live without signing in', async () => {
    const start = await h.api
      .post('/v1/live')
      .set(h.as('host'))
      .send({ title: 'Champagne night', type: 'video' });
    const res = await preview('live', start.body.room.id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(res.body.preview).toEqual({
      kind: 'live',
      type: 'video',
      status: 'live',
      title: 'Champagne night',
      coverUrl: null,
      host: { shortId: '777', displayName: 'Golden Host', avatarUrl: null },
    });
  });

  it('describes a profile by short id, and an active post', async () => {
    const user = await preview('user', '777');
    expect(user.body.preview).toMatchObject({
      kind: 'user',
      user: { shortId: '777', displayName: 'Golden Host', followers: 0 },
    });
    expect(user.headers['cache-control']).toBe('public, max-age=300');

    const post = await h.api.post('/v1/feed').set(h.as('writer')).send({ text: 'Golden hour' });
    const res = await preview('post', post.body.post.id);
    expect(res.body.preview).toMatchObject({
      kind: 'post',
      text: 'Golden hour',
      author: { shortId: '778' },
    });
  });

  it('is a 404 for unknown, malformed or hidden targets', async () => {
    await preview('live', new ObjectId().toHexString()).expect(404);
    await preview('live', 'not-an-id').expect(404);
    await preview('user', '779').expect(404); // banned
    await preview('clip', '777').expect(422);
    const post = await h.api.post('/v1/feed').set(h.as('writer')).send({ text: 'Soon gone' });
    await h.ctx.col.feedPosts.updateOne(
      { _id: new ObjectId(post.body.post.id as string) },
      { $set: { status: 'hidden' } },
    );
    await preview('post', post.body.post.id).expect(404);
  });

  it('opens a profile by short id for signed-in users', async () => {
    const res = await h.api.get('/v1/users/777').set(h.as('writer'));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('host');
  });
});
