import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  for (const uid of ['ann', 'ben', 'host', 'guest', 'viewer', 'rival', 'staff'])
    await h.user(uid, uid === 'staff' ? { adminRole: 'moderator' } : {});
});
afterAll(async () => h.close());
beforeEach(() => {
  h.sightguard.reset();
  h.ctx.env.SIGHTGUARD_AUTO_BAN = false;
});

const img = (uid: string, folder = 'avatars') =>
  `https://cdn.test/${folder}/${uid}/${new ObjectId().toHexString()}.webp`;

let evtSeq = 0;
const deliver = (type: string, data: Record<string, unknown>, id = `evt_${evtSeq++}`) =>
  h.api
    .post('/v1/webhooks/sightguard')
    .set('sightguard-signature', 'valid-signature')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ id, type, createdAt: '', projectId: 'p', data }));

const violation = (room: string, uid: string, action: string, extra: object = {}) =>
  deliver('live.violation', {
    sessionId: 's',
    room,
    participantIdentity: uid,
    trackSid: 'TR',
    source: 'video',
    action,
    strikes: 1,
    reasons: [{ category: 'nudity.explicit' }],
    scores: {},
    evidence: {},
    enforced: false,
    recommendBan: false,
    ...extra,
  });

const review = (metadata: Record<string, string>, extra: object = {}) =>
  deliver('review.completed', {
    reviewId: 'r',
    requestId: 'q',
    kind: 'text',
    channel: 'comment',
    decision: 'reject',
    reviewer: 'mod@sightguard',
    note: null,
    metadata,
    ...extra,
  });

/** Starts a live for `host` (ending any previous one) and returns its ids. */
const goLive = async (host: string) => {
  await h.ctx.services.live.endActiveRoomFor(host, 'host', host);
  h.clock.advance(1); // LiveKit room names carry the start time
  const res = await h.api.post('/v1/live').set(h.as(host)).send({ type: 'video' });
  expect(res.status).toBe(201);
  await h.jobs.drain();
  return { id: res.body.room.id as string, livekitRoom: res.body.room.livekitRoom as string };
};
const roomDoc = (id: string) => h.ctx.col.liveRooms.findOne({ _id: new ObjectId(id) });

describe('SightGuard checks', () => {
  it('sends nothing when SightGuard is disabled', async () => {
    h.sightguard.enabled = false;
    h.sightguard.reject('Terrible words');
    await h.api.patch('/v1/me').set(h.as('ann')).send({ bio: 'Terrible words' }).expect(200);
    expect(h.sightguard.checks).toEqual([]);
  });

  it('refuses a rejected avatar and checks it with the avatar ref', async () => {
    const url = img('ann');
    h.sightguard.reject(url, 'nudity.explicit');
    const res = await h.api.patch('/v1/me').set(h.as('ann')).send({ avatarUrl: url });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'content_rejected',
      details: { categories: ['nudity.explicit'] },
    });
    expect(h.sightguard.checks[0]).toMatchObject({
      kind: 'image',
      req: { channel: 'avatar', userRef: 'ann', metadata: { type: 'avatar', uid: 'ann', url } },
    });
    expect((await h.ctx.col.users.findOne({ _id: 'ann' }))!.avatarUrl).toBeNull();
  });

  it('fails closed for avatars and open for profile text when SightGuard is down', async () => {
    h.sightguard.outage = 'down';
    const res = await h.api
      .patch('/v1/me')
      .set(h.as('ann'))
      .send({ avatarUrl: img('ann') });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('moderation_unavailable');
    await h.api.patch('/v1/me').set(h.as('ann')).send({ bio: 'Hello there' }).expect(200);
  });

  it('refuses undecodable avatars', async () => {
    h.sightguard.outage = 'invalid_media';
    const res = await h.api
      .patch('/v1/me')
      .set(h.as('ann'))
      .send({ avatarUrl: img('ann') });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('content_rejected');
  });

  it('only checks profile fields that changed', async () => {
    const url = img('ann');
    await h.api
      .patch('/v1/me')
      .set(h.as('ann'))
      .send({ avatarUrl: url, displayName: 'Ann Boss' })
      .expect(200);
    expect(h.sightguard.checks.map((c) => c.req.channel).sort()).toEqual(['avatar', 'username']);
    h.sightguard.reset();
    h.sightguard.outage = 'down'; // an unchanged avatar must not fail closed
    await h.api
      .patch('/v1/me')
      .set(h.as('ann'))
      .send({ avatarUrl: url, displayName: 'Ann Boss', gender: 'female' })
      .expect(200);
    expect(h.sightguard.checks).toEqual([]);
  });

  it('refuses rejected display names', async () => {
    h.sightguard.reject('Bad Name', 'text.insult');
    const res = await h.api.patch('/v1/me').set(h.as('ben')).send({ displayName: 'Bad Name' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('content_rejected');
  });

  it('moderates feed text and images, failing open for post images', async () => {
    h.sightguard.reject('vile post');
    expect((await h.api.post('/v1/feed').set(h.as('ann')).send({ text: 'vile post' })).status).toBe(
      422,
    );
    const bad = img('ann', 'posts');
    h.sightguard.reject(bad);
    const refused = await h.api
      .post('/v1/feed')
      .set(h.as('ann'))
      .send({ text: 'look', media: [{ url: bad, type: 'image' }] });
    expect(refused.status).toBe(422);
    expect(await h.ctx.col.feedPosts.countDocuments({ text: 'look' })).toBe(0);

    h.sightguard.reset();
    h.sightguard.outage = 'down';
    await h.api
      .post('/v1/feed')
      .set(h.as('ann'))
      .send({ text: 'outage', media: [{ url: img('ann', 'posts'), type: 'image' }] })
      .expect(201);
  });

  it('moderates comments and private messages', async () => {
    const post = await h.api.post('/v1/feed').set(h.as('ann')).send({ text: 'Morning' });
    h.sightguard.reject('nasty reply');
    const c = await h.api
      .post(`/v1/feed/${post.body.post.id}/comments`)
      .set(h.as('ben'))
      .send({ text: 'nasty reply' });
    expect(c.status).toBe(422);

    h.sightguard.reject('nasty dm');
    const dm = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ben'))
      .send({ toUserId: 'ann', type: 'text', text: 'nasty dm' });
    expect(dm.status).toBe(422);
    const pic = img('ben', 'chat');
    h.sightguard.reject(pic);
    const image = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ben'))
      .send({ toUserId: 'ann', type: 'image', mediaUrl: pic });
    expect(image.status).toBe(422);
    expect(h.sightguard.checks.at(-1)!.req.channel).toBe('chat_media');
  });

  it('submits feed videos asynchronously and removes the post when rejected', async () => {
    const url = img('ann', 'posts').replace('.webp', '.mp4');
    const res = await h.api
      .post('/v1/feed')
      .set(h.as('ann'))
      .send({ text: 'clip', media: [{ url, type: 'video' }] });
    expect(res.status).toBe(201);
    await h.jobs.drain();
    const postId = res.body.post.id as string;
    expect(h.sightguard.videos).toEqual([
      {
        url,
        req: { channel: 'post_video', userRef: 'ann', metadata: { type: 'post', postId } },
      },
    ]);
    await deliver('video.completed', {
      id: 'job',
      status: 'completed',
      decision: 'reject',
      metadata: { type: 'post', postId },
    }).expect(200);
    expect((await h.ctx.col.feedPosts.findOne({ _id: new ObjectId(postId) }))!.status).toBe(
      'removed',
    );
  });

  it('refuses rejected live titles, covers and chat', async () => {
    h.sightguard.reject('filthy title');
    const start = await h.api
      .post('/v1/live')
      .set(h.as('host'))
      .send({ type: 'video', title: 'filthy title' });
    expect(start.status).toBe(422);
    h.sightguard.reset();
    h.sightguard.outage = 'down';
    const cover = await h.api
      .post('/v1/live')
      .set(h.as('host'))
      .send({ type: 'video', coverUrl: img('host', 'covers') });
    expect(cover.status).toBe(503);

    h.sightguard.reset();
    const { id, livekitRoom } = await goLive('host');
    expect(h.sightguard.live).toEqual([{ op: 'start', room: livekitRoom, hostIdentity: 'host' }]);
    await h.api.post(`/v1/live/${id}/join`).set(h.as('viewer')).send({}).expect(200);
    h.sightguard.reject('vile chat');
    const sent = h.livekit.topics('bb.chat').length;
    const chat = await h.api
      .post(`/v1/live/${id}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'text', text: 'vile chat' });
    expect(chat.status).toBe(422);
    expect(h.livekit.topics('bb.chat').length).toBe(sent);
    expect(h.sightguard.checks.at(-1)!.req).toMatchObject({
      channel: 'live_chat',
      timeoutMs: h.ctx.env.SIGHTGUARD_CHAT_TIMEOUT_MS,
    });
    // Live chat fails open.
    h.sightguard.outage = 'down';
    await h.api
      .post(`/v1/live/${id}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'text', text: 'hello' })
      .expect(201);

    await h.api.post(`/v1/live/${id}/end`).set(h.as('host')).expect(200);
    h.sightguard.outage = false;
    await h.jobs.drain();
  });
});

describe('SightGuard webhooks', () => {
  it('rejects bad signatures and answers 404 when disabled', async () => {
    const bad = await h.api
      .post('/v1/webhooks/sightguard')
      .set('sightguard-signature', 'forged')
      .send(JSON.stringify({ id: 'x', type: 'ping', data: {} }));
    expect(bad.status).toBe(401);
    h.sightguard.enabled = false;
    expect((await deliver('ping', { message: 'hi' })).status).toBe(404);
  });

  it('de-duplicates deliveries by event id', async () => {
    expect((await deliver('ping', { message: 'hi' }, 'evt_dupe')).body).toEqual({
      ok: true,
      duplicate: false,
    });
    expect((await deliver('ping', { message: 'hi' }, 'evt_dupe')).body).toEqual({
      ok: true,
      duplicate: true,
    });
  });

  it('releases the dedupe row when handling fails, so the retry is processed', async () => {
    const live = h.ctx.services.live;
    const original = live.liveByLivekitRoom.bind(live);
    live.liveByLivekitRoom = async () => {
      throw new Error('mongo down');
    };
    expect(await violation('bb_x_1', 'host', 'warn', {}).then((r) => r.status)).toBe(500);
    live.liveByLivekitRoom = original;
    expect(await h.ctx.col.sightguardEvents.countDocuments({ _id: `evt_${evtSeq - 1}` })).toBe(0);
  });

  it('maps the live escalation ladder onto room actions', async () => {
    const { id, livekitRoom } = await goLive('host');
    await h.ctx.col.liveRooms.updateOne(
      { _id: new ObjectId(id), 'seats.index': 1 },
      { $set: { 'seats.$.userId': 'guest' } },
    );

    await violation(livekitRoom, 'guest', 'warn').expect(200);
    expect(h.livekit.data.filter((d) => d.topic === 'bb.system').at(-1)).toMatchObject({
      payload: { kind: 'moderation', action: 'warn' },
      identities: ['guest'],
    });
    expect(await h.ctx.col.notifications.countDocuments({ userId: 'guest', type: 'system' })).toBe(
      1,
    );

    await violation(livekitRoom, 'guest', 'mute_track').expect(200);
    expect(h.livekit.mutes.at(-1)).toMatchObject({ identity: 'guest', kind: 'video', muted: true });
    expect((await roomDoc(id))!.seats[1]).toMatchObject({ userId: 'guest', videoMuted: true });

    await violation(livekitRoom, 'guest', 'mute_track', { source: 'audio' }).expect(200);
    expect(h.livekit.mutes.at(-1)).toMatchObject({ identity: 'guest', kind: 'audio' });

    await violation(livekitRoom, 'guest', 'remove_participant').expect(200);
    expect(h.livekit.removed.at(-1)).toEqual({ room: livekitRoom, identity: 'guest' });
    expect(h.livekit.topics('bb.kick').at(-1)!.payload).toEqual({ uid: 'guest', by: 'system' });
    expect((await roomDoc(id))!.seats[1]!.userId).toBeNull();
    const ban = await h.ctx.col.roomBans.findOne({ hostId: 'host', userId: 'guest' });
    expect(ban).toMatchObject({ by: 'system' });
    expect((await h.api.post(`/v1/live/${id}/join`).set(h.as('guest'))).status).toBe(403);
    expect(
      await h.ctx.col.auditLogs.countDocuments({
        adminId: 'system',
        action: { $in: ['sightguard.live.mute', 'sightguard.live.remove'] },
      }),
    ).toBe(3);

    // The host can't be evicted from their own live: it is ended instead.
    await violation(livekitRoom, 'host', 'remove_participant').expect(200);
    expect(await roomDoc(id)).toMatchObject({ status: 'ended', endReason: 'moderation' });
    expect(h.livekit.topics('bb.room.ended').at(-1)!.payload).toEqual({
      roomId: id,
      reason: 'moderation',
    });
    await h.jobs.drain();
    expect(h.sightguard.live.at(-1)).toEqual({ op: 'end', room: livekitRoom });
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.status).toBe('active');
  });

  it('ignores rooms that are not ours or already ended', async () => {
    await violation('bb_unknown_1', 'host', 'end_room').expect(200);
  });

  it('bans on end_room only when auto-ban is on and SightGuard recommends it', async () => {
    let { livekitRoom } = await goLive('host');
    await violation(livekitRoom, 'host', 'end_room', { recommendBan: true }).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.status).toBe('active');

    h.ctx.env.SIGHTGUARD_AUTO_BAN = true;
    ({ livekitRoom } = await goLive('rival'));
    await violation(livekitRoom, 'rival', 'end_room', { recommendBan: true }).expect(200);
    const rival = (await h.ctx.col.users.findOne({ _id: 'rival' }))!;
    expect(rival.status).toBe('banned');
    expect(rival.ban).toMatchObject({ by: 'system', until: null });
    await h.ctx.services.users.unban('rival');
  });

  it('applies a PK opponent violation to the opponent own live', async () => {
    const a = await goLive('host');
    const b = await goLive('rival');
    const battleId = new ObjectId();
    await h.ctx.col.liveRooms.updateMany(
      { _id: { $in: [new ObjectId(a.id), new ObjectId(b.id)] } },
      { $set: { pkBattleId: battleId } },
    );
    // Rival's forwarded tracks are seen in host's room.
    await violation(a.livekitRoom, 'rival', 'end_room').expect(200);
    expect((await roomDoc(b.id))!.status).toBe('ended');
    expect((await roomDoc(a.id))!.status).toBe('live');
    await h.ctx.col.liveRooms.updateOne(
      { _id: new ObjectId(a.id) },
      { $set: { pkBattleId: null } },
    );
    await h.ctx.services.live.endActiveRoomFor('host', 'host', 'host');
  });

  it('undoes published content when a moderator rejects it on review', async () => {
    // Comment
    const post = await h.api.post('/v1/feed').set(h.as('ann')).send({ text: 'Evening' });
    const postId = post.body.post.id as string;
    const c = await h.api
      .post(`/v1/feed/${postId}/comments`)
      .set(h.as('ben'))
      .send({ text: 'borderline' });
    const commentId = h.sightguard.checks.at(-1)!.req.metadata!.commentId!;
    expect(commentId).toBe(c.body.comment.id);
    await review({ type: 'comment', commentId }).expect(200);
    await review({ type: 'comment', commentId }).expect(200); // second verdict: no double count
    expect((await h.ctx.col.feedComments.findOne({ _id: new ObjectId(commentId) }))!.status).toBe(
      'removed',
    );
    expect((await h.ctx.col.feedPosts.findOne({ _id: new ObjectId(postId) }))!.commentCount).toBe(
      0,
    );

    // Post
    await review({ type: 'post', postId }).expect(200);
    expect((await h.ctx.col.feedPosts.findOne({ _id: new ObjectId(postId) }))!.status).toBe(
      'removed',
    );

    // Private message: removed for both and out of the conversation preview.
    const dm = await h.api
      .post('/v1/chat/messages')
      .set(h.as('ben'))
      .send({ toUserId: 'ann', type: 'text', text: 'borderline dm' });
    const messageId = dm.body.message.id as string;
    await review({ type: 'message', messageId }).expect(200);
    const thread = await h.api
      .get(`/v1/chat/conversations/${dm.body.message.conversationId}/messages`)
      .set(h.as('ann'));
    expect(thread.body.items.map((m: { id: string }) => m.id)).not.toContain(messageId);
    const conv = await h.ctx.col.conversations.findOne({
      _id: new ObjectId(dm.body.message.conversationId as string),
    });
    expect(conv!.lastMessage!.text).toBe('Message removed');

    // Avatar: only if it is still theirs.
    const url = img('ben');
    await h.api.patch('/v1/me').set(h.as('ben')).send({ avatarUrl: url }).expect(200);
    await review({ type: 'avatar', uid: 'ben', url }).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'ben' }))!.avatarUrl).toBeNull();

    // Display name and bio.
    await review({ type: 'profile', uid: 'ben', field: 'displayName' }).expect(200);
    await review({ type: 'profile', uid: 'ben', field: 'bio' }).expect(200);
    const ben = (await h.ctx.col.users.findOne({ _id: 'ben' }))!;
    expect(ben.displayName).toBe(`Boss${ben.shortId}`);
    expect(ben.bio).toBe('');
    expect(
      await h.ctx.col.notifications.countDocuments({ userId: 'ben', title: 'Content removed' }),
    ).toBeGreaterThanOrEqual(4);

    // Approvals and foreign metadata change nothing.
    await review({ type: 'post', postId: new ObjectId().toHexString() }, { decision: 'allow' });
    await review({ type: 'something_else', id: '1' }).expect(200);
  });

  it('undoes live titles, covers and chat after a review reject', async () => {
    const { id } = await goLive('host');
    await h.api
      .patch(`/v1/live/${id}`)
      .set(h.as('host'))
      .send({ title: 'Borderline', coverUrl: img('host', 'covers') })
      .expect(200);
    const cover = (await roomDoc(id))!.coverUrl!;
    await review({ type: 'live_title', roomId: id }).expect(200);
    await review({ type: 'live_cover', roomId: id, field: 'coverUrl', url: cover }).expect(200);
    const room = (await roomDoc(id))!;
    expect(room.title).toBe('User host');
    expect(room.coverUrl).toBeNull();

    await h.api.post(`/v1/live/${id}/join`).set(h.as('viewer')).send({}).expect(200);
    const msg = await h.api
      .post(`/v1/live/${id}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'text', text: 'borderline chat' });
    await review({ type: 'live_message', roomId: id, messageId: msg.body.message.id }).expect(200);
    expect(h.livekit.topics('bb.system').at(-1)!.payload).toEqual({
      kind: 'chat_deleted',
      id: msg.body.message.id,
    });
    await h.ctx.services.live.endActiveRoomFor('host', 'host', 'host');
  });

  it('bans on a confirmed live review only with auto-ban, never staff', async () => {
    await review({}, { kind: 'live', userRef: 'viewer' }).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'viewer' }))!.status).toBe('active');
    h.ctx.env.SIGHTGUARD_AUTO_BAN = true;
    await review({}, { kind: 'live', userRef: 'staff' }).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'staff' }))!.status).toBe('active');
    await review({}, { kind: 'live', userRef: 'viewer' }).expect(200);
    expect((await h.ctx.col.users.findOne({ _id: 'viewer' }))!.status).toBe('banned');
  });
});
