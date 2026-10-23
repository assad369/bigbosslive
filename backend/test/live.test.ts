import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('host', {
    displayName: 'Golden Host',
    level: { level: 7, points: 7000 },
    vip: { tier: 2, expiresAt: new Date('2030-01-01') },
  });
  await h.user('viewer', { level: { level: 3, points: 300 } });
  await h.user('mod');
  await h.user('troll');
});
afterAll(async () => h.close());

const webhook = (event: string, room: string, identity?: string) =>
  h.api
    .post('/v1/webhooks/livekit')
    .set('Authorization', 'valid-signature')
    .set('Content-Type', 'application/webhook+json')
    .send(
      JSON.stringify({
        event,
        room: { name: room },
        ...(identity ? { participant: { identity } } : {}),
      }),
    );

describe('live rooms', () => {
  let roomId: string;
  let livekitRoom: string;

  it('starts a live with a host publish token carrying server-minted metadata', async () => {
    const res = await h.api
      .post('/v1/live')
      .set(h.as('host'))
      .send({ title: 'Champagne night', type: 'video' });
    expect(res.status).toBe(201);
    roomId = res.body.room.id;
    livekitRoom = res.body.room.livekitRoom;
    expect(res.body.credentials).toMatchObject({
      identity: 'host',
      role: 'host',
      url: 'wss://livekit.test',
    });
    const token = h.livekit.tokens.at(-1)!;
    expect(token).toMatchObject({ canPublish: true, identity: 'host', room: livekitRoom });
    expect(token.metadata).toMatchObject({ level: 7, vipTier: 2, role: 'host' });
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.liveRoomId).toEqual(
      new ObjectId(roomId),
    );
  });

  it('resumes instead of creating a second live room', async () => {
    const res = await h.api.post('/v1/live').set(h.as('host')).send({ title: 'Again' });
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(res.body.room.id).toBe(roomId);
    expect(await h.ctx.col.liveRooms.countDocuments({ hostId: 'host', status: 'live' })).toBe(1);
  });

  it('gives viewers subscribe-only tokens', async () => {
    const res = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('viewer'));
    expect(res.status).toBe(200);
    expect(res.body.credentials.role).toBe('audience');
    expect(h.livekit.tokens.at(-1)).toMatchObject({ canPublish: false, identity: 'viewer' });
  });

  it('lists live rooms with host briefs', async () => {
    const res = await h.api.get('/v1/live?tab=popular').set(h.as('viewer'));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: roomId,
      host: { id: 'host', displayName: 'Golden Host', level: 7 },
    });
  });

  it('counts viewers from webhooks idempotently', async () => {
    expect((await webhook('participant_joined', livekitRoom, 'viewer')).status).toBe(200);
    await webhook('participant_joined', livekitRoom, 'viewer'); // redelivery
    await webhook('participant_joined', livekitRoom, 'mod');
    await webhook('participant_joined', livekitRoom, 'host'); // host is not a viewer
    let room = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(room).toMatchObject({ viewerCount: 2, peakViewers: 2 });
    await webhook('participant_left', livekitRoom, 'mod');
    await webhook('participant_left', livekitRoom, 'mod');
    room = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(room).toMatchObject({ viewerCount: 1, peakViewers: 2 });
  });

  it('rejects webhooks with a bad signature', async () => {
    const res = await h.api.post('/v1/webhooks/livekit').set('Authorization', 'forged').send('{}');
    expect(res.status).toBe(401);
  });

  it('lets moderators kick and ban; banned users cannot rejoin', async () => {
    await h.api
      .post(`/v1/live/${roomId}/moderators`)
      .set(h.as('host'))
      .send({ userId: 'mod', enabled: true })
      .expect(204);
    const kick = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('mod'))
      .send({ userId: 'troll', banMinutes: 30 });
    expect(kick.status).toBe(204);
    expect(h.livekit.removed).toContainEqual({ room: livekitRoom, identity: 'troll' });
    const rejoin = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('troll'));
    expect(rejoin.status).toBe(403);
    expect(rejoin.body.error.code).toBe('room_banned');
    // Ordinary viewers cannot kick.
    expect(
      (await h.api.post(`/v1/live/${roomId}/kick`).set(h.as('viewer')).send({ userId: 'mod' }))
        .status,
    ).toBe(403);
    h.clock.advance(31 * 60);
    expect((await h.api.post(`/v1/live/${roomId}/join`).set(h.as('troll'))).status).toBe(200);
  });

  it('moderates in-room chat and fans it out on the data channel', async () => {
    const ok = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ text: 'hello shit show' });
    expect(ok.status).toBe(201);
    expect(ok.body.message.text).toBe('hello **** show');
    expect(h.livekit.topics('bb.chat').at(-1)!.payload).toMatchObject({
      text: 'hello **** show',
      user: { uid: 'viewer', level: 3 },
    });
    const spam = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ text: 'join t.me/scam' });
    expect(spam.status).toBe(422);
  });

  it('seats a guest on request and grants publish permission', async () => {
    await h.api.post(`/v1/live/${roomId}/seats/request`).set(h.as('viewer')).expect(202);
    const pending = await h.api.get(`/v1/live/${roomId}/seats/requests`).set(h.as('host'));
    expect(pending.body.items).toHaveLength(1);
    const accept = await h.api
      .post(`/v1/live/${roomId}/seats/requests/viewer`)
      .set(h.as('host'))
      .send({ accept: true });
    expect(accept.body).toEqual({ seated: true, index: 1 });
    expect(h.livekit.permissions.at(-1)).toEqual({
      room: livekitRoom,
      identity: 'viewer',
      canPublish: true,
    });
    const rejoin = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('viewer'));
    expect(rejoin.body.credentials.role).toBe('guest');
    await h.api.post(`/v1/live/${roomId}/seats/leave`).set(h.as('viewer')).expect(204);
    expect(h.livekit.permissions.at(-1)).toEqual({
      room: livekitRoom,
      identity: 'viewer',
      canPublish: false,
    });
  });

  it('ends the room, books live time and returns a summary', async () => {
    h.clock.advance(600);
    const res = await h.api.post(`/v1/live/${roomId}/end`).set(h.as('host'));
    expect(res.status).toBe(200);
    expect(res.body.summary.durationSec).toBeGreaterThanOrEqual(600);
    const host = await h.ctx.col.users.findOne({ _id: 'host' });
    expect(host!.liveRoomId).toBeNull();
    expect(host!.stats.liveSeconds).toBe(res.body.summary.durationSec);
    expect(h.livekit.deletedRooms).toContain(livekitRoom);
    expect((await h.api.post(`/v1/live/${roomId}/join`).set(h.as('viewer'))).status).toBe(410);
    // Ending twice is a no-op, not a double booking.
    await h.api.post(`/v1/live/${roomId}/end`).set(h.as('host'));
    expect((await h.ctx.col.users.findOne({ _id: 'host' }))!.stats.liveSeconds).toBe(
      res.body.summary.durationSec,
    );
  });

  it('closes rooms that stop heart-beating', async () => {
    const { room } = await h.ctx.services.live.start('mod', {
      type: 'audio',
      title: 'Talk',
      coverUrl: null,
      tags: [],
    });
    h.clock.advance(60);
    await h.api.post(`/v1/live/${room.id}/heartbeat`).set(h.as('mod')).expect(204);
    h.clock.advance(60);
    expect(await h.ctx.services.live.sweepStale()).toBe(0);
    h.clock.advance(60);
    expect(await h.ctx.services.live.sweepStale()).toBe(1);
    expect((await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(room.id) }))!.endReason).toBe(
      'stale',
    );
  });
});
