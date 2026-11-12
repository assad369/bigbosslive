import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminRole } from '@bigboss/shared';
import { createHarness, key, type Harness } from './helpers/harness.js';

let h: Harness;
const MOD = { since: new Date('2026-01-01T00:00:00Z'), by: 'boss' };

beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
  await h.user('support1', { adminRole: 'support' });
  await h.user('liveStaff', { adminRole: 'moderator' });
  await h.user('mod', { platformModerator: MOD, displayName: 'Mod Squad' });
  await h.user('mod2', { platformModerator: MOD });
  await h.user('host');
  await h.user('viewer', { shortId: '4321', displayName: 'Rowdy Viewer' });
  await h.user('alt');
  await h.user('plain');
});
afterAll(async () => h.close());

const webhook = (event: string, room: string, identity: string, hidden = false) =>
  h.api
    .post('/v1/webhooks/livekit')
    .set('Authorization', 'valid-signature')
    .set('Content-Type', 'application/webhook+json')
    .send(
      JSON.stringify({
        event,
        room: { name: room },
        participant: { identity, permission: { hidden } },
      }),
    );

const goLive = async (host = 'host') => {
  // LiveKit room names carry the start time; the test clock is frozen.
  h.clock.advance(1);
  const res = await h.api.post('/v1/live').set(h.as(host)).send({ type: 'video' });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { roomId: res.body.room.id as string, livekitRoom: res.body.room.livekitRoom as string };
};
const endLive = (host = 'host') => h.ctx.services.live.endActiveRoomFor(host, 'host', host);
const setConfig = (v: Record<string, unknown>) =>
  h.ctx.services.config.set('platformModerators', v, 'boss');

describe('granting the role', () => {
  it('needs moderators.manage, is audited, and shows in /me', async () => {
    await h.user('candidate', { shortId: '5555' });
    const support = await h.api
      .post('/v1/admin/users/candidate/platform-moderator')
      .set(h.as('support1', 'support'))
      .send({ enabled: true });
    expect(support.status).toBe(403);

    const before = await h.api.get('/v1/me').set(h.as('candidate'));
    expect(before.body.user.moderation).toBeNull();

    await h.api
      .post('/v1/admin/platform-moderators')
      .set(h.as('boss', 'admin'))
      .send({ user: '5555' })
      .expect(204);
    const me = await h.api.get('/v1/me').set(h.as('candidate'));
    expect(me.body.user.moderation).toEqual({
      isPlatformModerator: true,
      canModerateLive: true,
      stealthEnabled: false,
      selfStageEnabled: false,
    });
    const audits = await h.ctx.col.auditLogs
      .find({ action: 'user.platform_moderator', targetId: 'candidate' })
      .toArray();
    expect(audits).toHaveLength(1);

    const list = await h.api.get('/v1/admin/platform-moderators').set(h.as('boss', 'admin'));
    expect(list.body.items.map((i: { user: { id: string } }) => i.user.id)).toContain('candidate');

    // The flag gives no dashboard access.
    expect((await h.api.get('/v1/admin/me').set(h.as('candidate'))).status).toBe(403);
  });

  it('a banned account cannot be made a moderator', async () => {
    await h.user('baddie', { status: 'banned' });
    const res = await h.api
      .post('/v1/admin/users/baddie/platform-moderator')
      .set(h.as('boss', 'admin'))
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('staff with live.moderate moderate lives but are not platform moderators', async () => {
    const me = await h.api.get('/v1/me').set(h.as('liveStaff', 'moderator'));
    expect(me.body.user.moderation).toMatchObject({
      isPlatformModerator: false,
      canModerateLive: true,
      stealthEnabled: false,
    });
    const support = await h.api.get('/v1/me').set(h.as('support1', 'support'));
    expect(support.body.user.moderation).toBeNull();
  });
});

describe('moderation panel', () => {
  it('is closed to everyone else', async () => {
    expect((await h.api.get('/v1/moderator/users').set(h.as('plain'))).status).toBe(403);
    expect((await h.api.get('/v1/moderator/users').set(h.as('support1', 'support'))).status).toBe(
      403,
    );
  });

  it('searches by short id, uid and name prefix, and pages', async () => {
    const byShort = await h.api.get('/v1/moderator/users?q=4321').set(h.as('mod'));
    expect(byShort.body.items.map((i: { user: { id: string } }) => i.user.id)).toEqual(['viewer']);
    const byName = await h.api.get('/v1/moderator/users?q=rowdy').set(h.as('mod'));
    expect(byName.body.items[0].user.id).toBe('viewer');
    const byUid = await h.api.get('/v1/moderator/users?q=alt').set(h.as('mod'));
    expect(byUid.body.items.map((i: { user: { id: string } }) => i.user.id)).toContain('alt');
    expect(byUid.body.items[0]).not.toHaveProperty('email');

    const first = await h.api.get('/v1/moderator/users?limit=2').set(h.as('mod'));
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await h.api
      .get(`/v1/moderator/users?limit=2&cursor=${first.body.nextCursor}`)
      .set(h.as('mod'));
    const ids = [...first.body.items, ...second.body.items].map(
      (i: { user: { id: string } }) => i.user.id,
    );
    expect(new Set(ids).size).toBe(4);
  });

  it('bans with a duration, idempotently, and unbans', async () => {
    const k = key();
    const ban = await h.api
      .post('/v1/moderator/users/viewer/ban')
      .set(h.as('mod'))
      .set('Idempotency-Key', k)
      .send({ reason: 'Spamming the room', days: 7 });
    expect(ban.status, JSON.stringify(ban.body)).toBe(200);
    expect(ban.body.user.status).toBe('banned');
    expect(ban.body.until).toBeTruthy();
    const retry = await h.api
      .post('/v1/moderator/users/viewer/ban')
      .set(h.as('mod'))
      .set('Idempotency-Key', k)
      .send({ reason: 'Spamming the room', days: 7 });
    expect(retry.body.replayed).toBe(true);
    expect(
      await h.ctx.col.auditLogs.countDocuments({
        action: 'moderator.user_ban',
        targetId: 'viewer',
      }),
    ).toBe(1);
    const row = await h.ctx.col.auditLogs.findOne({ action: 'moderator.user_ban' });
    expect(row?.adminRole).toBe('platform_moderator');
    expect(h.auth.revoked).toContain('viewer');

    const unban = await h.api.post('/v1/moderator/users/viewer/unban').set(h.as('mod'));
    expect(unban.body.user.status).toBe('active');
  });

  it('refuses short reasons, other durations, self and protected accounts', async () => {
    const send = (uid: string, body: Record<string, unknown>, as = 'mod') =>
      h.api
        .post(`/v1/moderator/users/${uid}/ban`)
        .set(h.as(as))
        .set('Idempotency-Key', key())
        .send(body);
    // Body validation answers 422.
    expect((await send('alt', { reason: 'no' })).status).toBe(422);
    expect((await send('alt', { reason: 'Spam', days: 3 })).status).toBe(422);
    expect((await send('mod', { reason: 'Myself' })).status).toBe(400);
    const peer = await send('mod2', { reason: 'Rogue moderator' });
    expect(peer.status).toBe(403);
    expect(peer.body.error.code).toBe('target_protected');
    expect((await send('boss', { reason: 'Staff account' })).status).toBe(403);
    // Staff may act on a platform moderator.
    const staff = await h.api
      .post('/v1/moderator/users/mod2/ban')
      .set(h.as('liveStaff', 'moderator'))
      .set('Idempotency-Key', key())
      .send({ reason: 'Abused the role', days: 1 });
    expect(staff.status).toBe(200);
    await h.api.post('/v1/moderator/users/mod2/unban').set(h.as('liveStaff', 'moderator'));
  });

  it('caps bans per moderator per hour', async () => {
    await setConfig({ banRateLimitPerHour: 1 });
    await h.user('spammer1');
    await h.user('spammer2');
    await h.user('limiter', { platformModerator: MOD });
    const ban = (uid: string) =>
      h.api
        .post(`/v1/moderator/users/${uid}/ban`)
        .set(h.as('limiter'))
        .set('Idempotency-Key', key())
        .send({ reason: 'Spam links' });
    expect((await ban('spammer1')).status).toBe(200);
    expect((await ban('spammer2')).status).toBe(429);
    h.clock.advance(3601);
    expect((await ban('spammer2')).status).toBe(200);
    await setConfig({});
  });

  it('previews and runs a device cascade that skips protected accounts and your own device', async () => {
    const now = h.clock.now();
    await h.user('cheater');
    await h.user('cheaterAlt');
    const seen = (userId: string, deviceId: string) =>
      h.ctx.col.devices.insertOne({
        userId,
        deviceId,
        platform: 'android',
        firstSeenAt: now,
        lastSeenAt: now,
      });
    await seen('cheater', 'device-aaaa');
    await seen('cheaterAlt', 'device-aaaa');
    await seen('mod2', 'device-aaaa');
    await seen('cheater', 'device-mine');

    const devices = await h.api
      .get('/v1/moderator/users/cheater/devices')
      .set(h.as('mod'))
      .set('X-Device-Id', 'device-mine');
    const mine = devices.body.items.find((d: { deviceId: string }) => d.deviceId === 'device-mine');
    expect(mine.isYours).toBe(true);
    expect(
      devices.body.items.find((d: { deviceId: string }) => d.deviceId === 'device-aaaa')
        .accountCount,
    ).toBe(3);

    const preview = await h.api
      .get('/v1/moderator/users/cheater/device-ban-preview')
      .set(h.as('mod'))
      .set('X-Device-Id', 'device-mine');
    expect(preview.body).toMatchObject({ devices: 1, accounts: 2 });
    expect(preview.body.skipped.map((s: { uid: string }) => s.uid)).toEqual(['mod2']);
    expect(await h.ctx.col.deviceBans.countDocuments()).toBe(0);

    const ban = await h.api
      .post('/v1/moderator/users/cheater/ban')
      .set(h.as('mod'))
      .set('X-Device-Id', 'device-mine')
      .set('Idempotency-Key', key())
      .send({ reason: 'Ban evasion', banDevices: true });
    expect(ban.status, JSON.stringify(ban.body)).toBe(200);
    expect(ban.body.devices).toMatchObject({ devicesBanned: 1, accountsBanned: 1 });
    expect((await h.ctx.col.users.findOne({ _id: 'cheaterAlt' }))!.status).toBe('banned');
    expect((await h.ctx.col.users.findOne({ _id: 'mod2' }))!.status).toBe('active');
    expect(await h.ctx.col.deviceBans.findOne({ _id: 'device-mine' })).toBeNull();

    const own = await h.api
      .post('/v1/moderator/devices/device-mine/ban')
      .set(h.as('mod'))
      .set('X-Device-Id', 'device-mine')
      .set('Idempotency-Key', key())
      .send({ reason: 'Oops' });
    expect(own.status).toBe(400);
  });

  it('lists and lifts the live bans hosts gave a user', async () => {
    const now = h.clock.now();
    await h.ctx.col.roomBans.insertOne({
      hostId: 'host',
      userId: 'alt',
      until: null,
      by: 'host',
      createdAt: now,
    });
    const list = await h.api.get('/v1/moderator/users/alt/room-bans').set(h.as('mod'));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].host.id).toBe('host');
    await h.api.delete('/v1/moderator/room-bans/host/alt').set(h.as('mod')).expect(204);
    expect(await h.ctx.col.roomBans.countDocuments({ userId: 'alt' })).toBe(0);
  });
});

describe('in a live room', () => {
  it('support staff no longer moderate; platform moderators do, and are audited', async () => {
    const { roomId } = await goLive();
    const supportKick = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('support1', 'support'))
      .send({ userId: 'plain' });
    expect(supportKick.status).toBe(403);

    const kick = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('mod'))
      .send({ userId: 'plain', banMinutes: null });
    expect(kick.status).toBe(204);
    const audit = await h.ctx.col.auditLogs.findOne({ action: 'live.kick', adminId: 'mod' });
    expect(audit?.payload).toMatchObject({ userId: 'plain', banMinutes: null });
    await h.ctx.col.roomBans.deleteMany({});
    await endLive();
  });

  it('hosts cannot remove platform moderators or staff; staff can', async () => {
    const { roomId } = await goLive();
    const byHost = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('host'))
      .send({ userId: 'mod' });
    expect(byHost.status).toBe(403);
    expect(byHost.body.error.code).toBe('target_protected');
    const byPeer = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('mod2'))
      .send({ userId: 'mod' });
    expect(byPeer.status).toBe(403);
    const byStaff = await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('liveStaff', 'moderator'))
      .send({ userId: 'mod' });
    expect(byStaff.status).toBe(204);
    await h.ctx.col.roomBans.deleteMany({});
    await endLive();
  });

  it('platform moderators pass host bans, blocks and locks', async () => {
    const { roomId } = await goLive();
    await h.ctx.col.roomBans.insertOne({
      hostId: 'host',
      userId: 'mod',
      until: null,
      by: 'host',
      createdAt: h.clock.now(),
    });
    await h.api.post('/v1/users/mod/block').set(h.as('host'));
    await h.api.post(`/v1/live/${roomId}/lock`).set(h.as('host')).send({ locked: true });
    const join = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod'));
    expect(join.status, JSON.stringify(join.body)).toBe(200);
    expect(join.body.stealth).toBe(false);
    await h.ctx.col.roomBans.deleteMany({});
    await h.ctx.col.blocks.deleteMany({});
    await endLive();
  });

  it('ends anyone’s live from the app, audited', async () => {
    const { roomId } = await goLive();
    expect((await h.api.post(`/v1/moderator/live/${roomId}/end`).set(h.as('plain'))).status).toBe(
      403,
    );
    await h.api.post(`/v1/moderator/live/${roomId}/end`).set(h.as('mod')).expect(204);
    const room = await h.ctx.col.liveRooms.findOne({ hostId: 'host' }, { sort: { startedAt: -1 } });
    expect(room).toMatchObject({ status: 'ended', endReason: 'moderator', endedBy: 'mod' });
    expect(await h.ctx.col.auditLogs.countDocuments({ action: 'live.end', adminId: 'mod' })).toBe(
      1,
    );
  });
});

describe('stealth and self-stage', () => {
  it('joins hidden: no entrance, no count, no join line, and stays hidden through re-mints', async () => {
    await setConfig({ stealthEnabled: true, selfStageEnabled: true });
    const { roomId, livekitRoom } = await goLive();
    const join = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod'));
    expect(join.body.stealth).toBe(true);
    expect(join.body.entry).toBeNull();
    expect(join.body.room.moderatorIds).not.toContain('mod');
    const token = h.livekit.tokens.filter((t) => t.identity === 'mod').at(-1)!;
    expect(token.hidden).toBe(true);
    expect(token.metadata.stealth).toBe(true);

    await webhook('participant_joined', livekitRoom, 'viewer');
    await webhook('participant_joined', livekitRoom, 'mod', true);
    const room = await h.ctx.col.liveRooms.findOne({ livekitRoom });
    expect(room?.viewerCount).toBe(1);
    const viewers = await h.api.get(`/v1/live/${roomId}/viewers`).set(h.as('viewer'));
    expect(viewers.body.items.map((v: { id: string }) => v.id)).toEqual(['viewer']);
    const joinedLines = h.livekit
      .topics('bb.system')
      .map((d) => d.payload as { kind: string; joined?: { id: string } | null })
      .filter((p) => p.kind === 'viewers' && p.joined?.id === 'mod');
    expect(joinedLines).toHaveLength(0);

    // A chat line from a hidden moderator says so.
    const chat = await h.api
      .post(`/v1/live/${roomId}/chat`)
      .set(h.as('mod'))
      .send({ type: 'text', text: 'Please keep it friendly' });
    expect(chat.body.message.mod).toBe(true);

    // Self-stage: visible on a seat, hidden again after.
    const on = await h.api
      .post(`/v1/live/${roomId}/platform-moderator/stage`)
      .set(h.as('mod'))
      .send({ onStage: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.onStage).toBe(true);
    let perm = h.livekit.permissions.filter((p) => p.identity === 'mod').at(-1)!;
    expect(perm).toMatchObject({ canPublish: true, hidden: false });
    // Hidden, they weren't a room admin; visible on a seat, they are.
    expect((await h.ctx.col.liveRooms.findOne({ livekitRoom }))?.moderatorIds).toContain('mod');

    const off = await h.api
      .post(`/v1/live/${roomId}/platform-moderator/stage`)
      .set(h.as('mod'))
      .send({ onStage: false });
    expect(off.body.onStage).toBe(false);
    perm = h.livekit.permissions.filter((p) => p.identity === 'mod').at(-1)!;
    expect(perm).toMatchObject({ canPublish: false, hidden: true });
    expect(perm.metadata).toMatchObject({ role: 'audience', stealth: true });
    expect((await h.ctx.col.liveRooms.findOne({ livekitRoom }))?.moderatorIds).not.toContain('mod');
    // Leaving the admin list again is quiet: no "no longer a room admin" line.
    const quiet = h.livekit
      .topics('bb.system')
      .filter((d) => d.room === livekitRoom)
      .map((d) => d.payload as { kind: string; uid?: string; enabled?: boolean; user?: unknown })
      .filter((p) => p.kind === 'moderator' && p.uid === 'mod' && p.enabled === false);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.user).toBeUndefined();
    expect(
      await h.ctx.col.auditLogs.countDocuments({ action: 'live.platform_moderator_stage' }),
    ).toBe(2);

    // Appointing a room admin re-mints that person only; the moderator stays hidden.
    await h.api
      .post(`/v1/live/${roomId}/moderators`)
      .set(h.as('host'))
      .send({ userId: 'viewer', enabled: true })
      .expect(204);
    expect(h.livekit.permissions.filter((p) => p.identity === 'mod').at(-1)!.hidden).toBe(true);
    await endLive();
  });

  it('self-stage is refused when switched off and for anyone else', async () => {
    await setConfig({ stealthEnabled: true, selfStageEnabled: false });
    const { roomId } = await goLive();
    const off = await h.api
      .post(`/v1/live/${roomId}/platform-moderator/stage`)
      .set(h.as('mod'))
      .send({ onStage: true });
    expect(off.status).toBe(403);
    await setConfig({ stealthEnabled: true, selfStageEnabled: true });
    const plain = await h.api
      .post(`/v1/live/${roomId}/platform-moderator/stage`)
      .set(h.as('plain'))
      .send({ onStage: true });
    expect(plain.status).toBe(403);
    // Staff join visibly: stealth belongs to the flag.
    const staff = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('liveStaff', 'moderator'));
    expect(staff.body.stealth).toBe(false);
    await endLive();
  });

  it('revoking the role drops hidden sessions', async () => {
    await setConfig({ stealthEnabled: true });
    await h.user('tempMod', { platformModerator: MOD });
    const { roomId, livekitRoom } = await goLive();
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('tempMod')).expect(200);
    await webhook('participant_joined', livekitRoom, 'tempMod', true);
    await h.api
      .post('/v1/admin/users/tempMod/platform-moderator')
      .set(h.as('boss', 'admin'))
      .send({ enabled: false })
      .expect(204);
    expect(h.livekit.removed).toContainEqual({ room: livekitRoom, identity: 'tempMod' });
    expect(await h.ctx.col.roomPresence.countDocuments({ identity: 'tempMod' })).toBe(0);
    const me = await h.api.get('/v1/me').set(h.as('tempMod'));
    expect(me.body.user.moderation).toBeNull();
    await endLive();
    await setConfig({});
  });
});

describe('room admin', () => {
  type SystemPacket = { kind: string; uid?: string; enabled?: boolean; user?: { id: string } };
  const adminPackets = (livekitRoom: string, uid: string) =>
    h.livekit
      .topics('bb.system')
      .filter((d) => d.room === livekitRoom)
      .map((d) => d.payload as SystemPacket)
      .filter((p) => p.kind === 'moderator' && p.uid === uid);
  const roomOf = (livekitRoom: string) => h.ctx.col.liveRooms.findOne({ livekitRoom });
  const appoint = (
    roomId: string,
    as: string,
    userId: string,
    enabled: boolean,
    role?: AdminRole,
  ) =>
    h.api
      .post(`/v1/live/${roomId}/moderators`)
      .set(role ? h.as(as, role) : h.as(as))
      .send({ userId, enabled });

  it('a visible platform moderator becomes a room admin on join, announced once', async () => {
    await setConfig({});
    const { roomId, livekitRoom } = await goLive();
    const join = await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod'));
    expect(join.status, JSON.stringify(join.body)).toBe(200);
    expect(join.body.stealth).toBe(false);
    expect(join.body.room.moderatorIds).toContain('mod');
    expect(join.body.credentials.role).toBe('moderator');
    const token = h.livekit.tokens.filter((t) => t.identity === 'mod').at(-1)!;
    expect(token.metadata.role).toBe('moderator');
    expect(token.canPublish).toBe(false);

    // A reconnect announces nothing again.
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod')).send({ resume: true }).expect(200);
    const packets = adminPackets(livekitRoom, 'mod');
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ enabled: true, user: { id: 'mod' } });

    // Staff with live.moderate moderate, but are not made admins.
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('liveStaff', 'moderator')).expect(200);
    expect((await roomOf(livekitRoom))?.moderatorIds).not.toContain('liveStaff');
    await endLive();
  });

  it('platform moderators appoint and remove room admins in any live, audited', async () => {
    const { roomId, livekitRoom } = await goLive();
    await appoint(roomId, 'mod', 'viewer', true).expect(204);
    expect((await roomOf(livekitRoom))?.moderatorIds).toContain('viewer');
    expect(adminPackets(livekitRoom, 'viewer').at(-1)).toMatchObject({
      enabled: true,
      user: { id: 'viewer' },
    });
    const audit = await h.ctx.col.auditLogs.findOne({
      action: 'live.moderator_set',
      adminId: 'mod',
    });
    expect(audit?.payload).toMatchObject({ userId: 'viewer', enabled: true });

    // A room admin the host (or a moderator) appointed still can't appoint.
    const byAdmin = await appoint(roomId, 'viewer', 'plain', true);
    expect(byAdmin.status).toBe(403);
    // Nobody appoints the host, and a plain viewer can't appoint at all.
    expect((await appoint(roomId, 'mod', 'host', true)).status).toBe(400);
    expect((await appoint(roomId, 'plain', 'alt', true)).status).toBe(403);

    await appoint(roomId, 'mod', 'viewer', false).expect(204);
    expect((await roomOf(livekitRoom))?.moderatorIds).not.toContain('viewer');
    expect(
      await h.ctx.col.auditLogs.countDocuments({ action: 'live.moderator_set', adminId: 'mod' }),
    ).toBe(2);
    // The host's own appointments aren't audited.
    await appoint(roomId, 'host', 'viewer', true).expect(204);
    expect(
      await h.ctx.col.auditLogs.countDocuments({ action: 'live.moderator_set', adminId: 'host' }),
    ).toBe(0);
    await endLive();
  });

  it('only staff take the role from a platform moderator', async () => {
    const { roomId, livekitRoom } = await goLive();
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod')).expect(200);
    const byHost = await appoint(roomId, 'host', 'mod', false);
    expect(byHost.status).toBe(403);
    expect(byHost.body.error.code).toBe('target_protected');
    expect((await appoint(roomId, 'mod2', 'mod', false)).status).toBe(403);
    await appoint(roomId, 'liveStaff', 'mod', false, 'moderator').expect(204);
    expect((await roomOf(livekitRoom))?.moderatorIds).not.toContain('mod');
    await endLive();
  });

  it('moderator actions in another host’s room stay audited while they are its admin', async () => {
    const { roomId } = await goLive();
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('mod')).expect(200);
    const before = await h.ctx.col.auditLogs.countDocuments({
      action: 'live.kick',
      adminId: 'mod',
    });
    await h.api
      .post(`/v1/live/${roomId}/kick`)
      .set(h.as('mod'))
      .send({ userId: 'plain' })
      .expect(204);
    expect(await h.ctx.col.auditLogs.countDocuments({ action: 'live.kick', adminId: 'mod' })).toBe(
      before + 1,
    );
    await h.ctx.col.roomBans.deleteMany({});
    await endLive();
  });

  it('revoking the role drops room admin roles in lives', async () => {
    await h.user('tempMod2', { platformModerator: MOD });
    const { roomId, livekitRoom } = await goLive();
    await h.api.post(`/v1/live/${roomId}/join`).set(h.as('tempMod2')).expect(200);
    expect((await roomOf(livekitRoom))?.moderatorIds).toContain('tempMod2');
    await h.api
      .post('/v1/admin/users/tempMod2/platform-moderator')
      .set(h.as('boss', 'admin'))
      .send({ enabled: false })
      .expect(204);
    expect((await roomOf(livekitRoom))?.moderatorIds).not.toContain('tempMod2');
    expect(h.livekit.permissions.filter((p) => p.identity === 'tempMod2').at(-1)).toMatchObject({
      canPublish: false,
      hidden: false,
      metadata: { role: 'audience' },
    });
    await endLive();
  });
});
