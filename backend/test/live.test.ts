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
    // Clients correct their clock with this for the elapsed-time display.
    expect(res.body.room.serverTime).toBe(h.clock.now().toISOString());
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
    // Each first join is announced once with the live count and top viewers.
    const joins = h.livekit
      .topics('bb.system')
      .map((d) => d.payload as { kind: string; joined: { id: string } | null; count: number })
      .filter((p) => p.kind === 'viewers');
    expect(joins.map((p) => p.joined?.id ?? null)).toEqual(['viewer', null, 'mod']);
    expect(joins.at(-1)!.count).toBe(2);
    // The host has its own pill, so the avatar strip lists viewers only.
    const top = (joins.at(-1) as unknown as { top: { id: string }[] }).top.map((u) => u.id);
    expect(top).toHaveLength(2);
    expect(top).not.toContain('host');
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
    expect(h.livekit.permissions.at(-1)).toMatchObject({
      room: livekitRoom,
      identity: 'viewer',
      canPublish: true,
      metadata: { role: 'guest' },
    });
    const rejoin = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('viewer'));
    expect(rejoin.body.credentials.role).toBe('guest');
    await h.api.post(`/v1/live/${roomId}/seats/leave`).set(h.as('viewer')).expect(204);
    expect(h.livekit.permissions.at(-1)).toMatchObject({
      room: livekitRoom,
      identity: 'viewer',
      canPublish: false,
      metadata: { role: 'audience' },
    });
  });

  it('invites a viewer to a seat; host mutes are enforced on the SFU', async () => {
    await h.api
      .post(`/v1/live/${roomId}/seats/invite`)
      .set(h.as('mod'))
      .send({ userId: 'viewer' })
      .expect(202);
    const invite = h.livekit.topics('bb.seats').at(-1)!;
    expect(invite.identities).toEqual(['viewer']);
    expect(invite.payload).toMatchObject({ kind: 'invite', from: { uid: 'mod' } });
    const seated = await h.api
      .post(`/v1/live/${roomId}/seats/invite/respond`)
      .set(h.as('viewer'))
      .send({ accept: true });
    expect(seated.body).toEqual({ seated: true, index: 1 });

    await h.api
      .post(`/v1/live/${roomId}/seats/1`)
      .set(h.as('host'))
      .send({ action: 'mute' })
      .expect(204);
    await h.api
      .post(`/v1/live/${roomId}/seats/1`)
      .set(h.as('host'))
      .send({ action: 'camera_off' })
      .expect(204);
    expect(h.livekit.mutes.slice(-2)).toEqual([
      { room: livekitRoom, identity: 'viewer', kind: 'audio', muted: true },
      { room: livekitRoom, identity: 'viewer', kind: 'video', muted: true },
    ]);
    const detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('viewer'));
    expect(detail.body.room.seats[1]).toMatchObject({
      userId: 'viewer',
      muted: true,
      videoMuted: true,
    });
    // The host seat is off limits.
    expect(
      (await h.api.post(`/v1/live/${roomId}/seats/0`).set(h.as('mod')).send({ action: 'mute' }))
        .status,
    ).toBe(400);
    await h.api
      .post(`/v1/live/${roomId}/seats/1`)
      .set(h.as('mod'))
      .send({ action: 'remove' })
      .expect(204);
  });

  it('sizes the video stage from config', async () => {
    const detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('viewer'));
    expect(detail.body.room.seats).toHaveLength(9);
  });

  it('keeps chat for replies, voice notes from our bucket, and moderator deletes', async () => {
    const first = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('host'))
      .send({ type: 'text', text: 'Welcome everyone' });
    const reply = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'text', text: 'thanks!', replyToId: first.body.message.id });
    expect(reply.status).toBe(201);
    expect(reply.body.message.replyTo).toEqual({
      id: first.body.message.id,
      userId: 'host',
      displayName: 'Golden Host',
      text: 'Welcome everyone',
    });
    expect(reply.body.message.user.role).toBe('audience');

    const foreign = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'voice', voiceUrl: 'https://evil.test/voice/viewer/a.m4a', durationSec: 5 });
    expect(foreign.status).toBe(400);
    const notMine = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'voice', voiceUrl: 'https://cdn.test/voice/host/a.m4a', durationSec: 5 });
    expect(notMine.status).toBe(400);
    const voice = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('viewer'))
      .send({ type: 'voice', voiceUrl: 'https://cdn.test/voice/viewer/abc-1.m4a', durationSec: 7 });
    expect(voice.status).toBe(201);
    expect(voice.body.message.voice).toEqual({
      url: 'https://cdn.test/voice/viewer/abc-1.m4a',
      durationSec: 7,
    });

    // Viewers cannot delete other people's messages; moderators can.
    expect(
      (await h.api.delete(`/v1/live/${roomId}/chat/${first.body.message.id}`).set(h.as('viewer')))
        .status,
    ).toBe(403);
    await h.api
      .delete(`/v1/live/${roomId}/chat/${voice.body.message.id}`)
      .set(h.as('mod'))
      .expect(204);
    expect(h.livekit.topics('bb.system').at(-1)!.payload).toEqual({
      kind: 'chat_deleted',
      id: voice.body.message.id,
    });
    // A deleted message cannot be replied to.
    const late = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('host'))
      .send({ type: 'text', text: 'hm', replyToId: voice.body.message.id });
    expect(late.status).toBe(404);
  });

  it('fans out heart reactions with a per-user rate limit', async () => {
    for (let i = 0; i < 10; i++) {
      await h.api
        .post(`/v1/live/${roomId}/reactions`)
        .set(h.as('viewer'))
        .send({ count: 3 })
        .expect(204);
    }
    expect(h.livekit.topics('bb.reaction').at(-1)!.payload).toEqual({ uid: 'viewer', count: 3 });
    const limited = await h.api
      .post(`/v1/live/${roomId}/reactions`)
      .set(h.as('viewer'))
      .send({ count: 1 });
    expect(limited.status).toBe(429);
  });

  it('locks the room: new viewers need the password; staff and moderators pass', async () => {
    await h.user('newcomer');
    await h.user('staff');
    expect(
      (await h.api.post(`/v1/live/${roomId}/lock`).set(h.as('mod')).send({ locked: true })).status,
    ).toBe(404);
    const locked = await h.api
      .post(`/v1/live/${roomId}/lock`)
      .set(h.as('host'))
      .send({ locked: true, password: '4321' });
    expect(locked.body.room).toMatchObject({ locked: true, hasPassword: true });
    expect(h.livekit.topics('bb.system').at(-1)!.payload).toEqual({
      kind: 'lock',
      locked: true,
      hasPassword: true,
    });
    const stored = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(roomId) });
    expect(stored!.passwordHash).not.toContain('4321');

    const list = await h.api.get('/v1/live').set(h.as('newcomer'));
    expect(list.body.items[0]).toMatchObject({ locked: true, hasPassword: true });

    const blocked = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('newcomer'));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({
      code: 'room_locked',
      details: { hasPassword: true },
    });
    const wrong = await h.api
      .post(`/v1/live/${roomId}/join`)
      .set(h.as('newcomer'))
      .send({ password: '0000' });
    expect(wrong.body.error.code).toBe('wrong_password');
    await h.api
      .post(`/v1/live/${roomId}/join`)
      .set(h.as('newcomer'))
      .send({ password: '4321' })
      .expect(200);
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod')).expect(200);
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('staff', 'moderator')).expect(200);

    // Without a password the lock is absolute for ordinary viewers.
    await h.api
      .post(`/v1/live/${roomId}/lock`)
      .set(h.as('host'))
      .send({ locked: true })
      .expect(200);
    const noPw = await h.api
      .post(`/v1/live/${roomId}/join`)
      .set(h.as('newcomer'))
      .send({ password: '4321' });
    expect(noPw.body.error).toMatchObject({
      code: 'room_locked',
      details: { hasPassword: false },
    });
    const unlocked = await h.api
      .post(`/v1/live/${roomId}/lock`)
      .set(h.as('host'))
      .send({ locked: false, password: '1111' });
    expect(unlocked.body.room).toMatchObject({ locked: false, hasPassword: false });
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('newcomer')).expect(200);
  });

  it('caps password guesses per user', async () => {
    await h.ctx.services.live.setLock(new ObjectId(roomId), 'host', true, '9999');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await h.api.post(`/v1/live/${roomId}/join`).set(h.as('troll')).send({ password: '1234' })
      ).status;
    }
    expect(last).toBe(429);
    await h.ctx.services.live.setLock(new ObjectId(roomId), 'host', false, null);
  });

  it('revoking a moderator updates their role; kicking one also revokes it', async () => {
    await h.api
      .post(`/v1/live/${roomId}/moderators`)
      .set(h.as('host'))
      .send({ userId: 'newcomer', enabled: true })
      .expect(204);
    let detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('host'));
    expect(detail.body.room.moderators.map((m: { id: string }) => m.id)).toContain('newcomer');
    expect(h.livekit.permissions.at(-1)).toMatchObject({
      identity: 'newcomer',
      canPublish: false,
      metadata: { role: 'moderator' },
    });
    await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('host'))
      .send({ userId: 'newcomer', banMinutes: 1 })
      .expect(204);
    detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('host'));
    expect(detail.body.room.moderatorIds).not.toContain('newcomer');
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

describe('go-live defaults', () => {
  // The clock is frozen; advance it so a host's next room gets a distinct LiveKit name.
  const endLive = async (uid: string, id: string) => {
    await h.api.post(`/v1/live/${id}/end`).set(h.as(uid)).expect(200);
    h.clock.advance(1);
  };

  it("defaults the title to the host's name and the cover to their avatar", async () => {
    await h.user('fresh', { displayName: 'Fresh Face' });
    await h.ctx.col.users.updateOne(
      { _id: 'fresh' },
      { $set: { avatarUrl: 'https://cdn.test/avatars/fresh.jpg' } },
    );
    const res = await h.api.post('/v1/live').set(h.as('fresh')).send({ title: '  ' });
    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({
      title: 'Fresh Face',
      coverUrl: 'https://cdn.test/avatars/fresh.jpg',
    });
    const stored = await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(res.body.room.id) });
    expect(stored).toMatchObject({
      title: 'Fresh Face',
      coverUrl: 'https://cdn.test/avatars/fresh.jpg',
    });
    await endLive('fresh', res.body.room.id);
  });

  it('keeps an explicit title and cover', async () => {
    const res = await h.api
      .post('/v1/live')
      .set(h.as('fresh'))
      .send({ title: 'My show', coverUrl: 'https://cdn.test/covers/x.jpg' });
    expect(res.body.room).toMatchObject({
      title: 'My show',
      coverUrl: 'https://cdn.test/covers/x.jpg',
    });
    await endLive('fresh', res.body.room.id);
  });

  it('leaves the cover empty when the host has no avatar', async () => {
    await h.user('plain', { displayName: 'Plain Jane' });
    const res = await h.api.post('/v1/live').set(h.as('plain')).send({});
    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({ title: 'Plain Jane', coverUrl: null });
    expect(
      (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(res.body.room.id) }))!.coverUrl,
    ).toBeNull();
    await endLive('plain', res.body.room.id);
  });
});
