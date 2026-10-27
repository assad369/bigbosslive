import { ObjectId, type Filter, type Sort } from 'mongodb';
import { z } from 'zod';
import { LIVEKIT_TOPICS, ROOM_TYPES, SOCKET, type RoomType } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LiveMessageDoc, LiveRoomDoc, SeatDoc } from '../../db/schema.js';
import {
  AppError,
  badRequest,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { addSeconds } from '../../lib/time.js';
import { activeVipTier } from '../users/users.presenter.js';
import { toLiveRoom, toRoomDetail } from './live.presenter.js';

const objectIdHex = z.string().regex(/^[a-f0-9]{24}$/i);

export const startLiveInput = z.object({
  type: z.enum(ROOM_TYPES).default('video'),
  /** Optional: an empty or missing title defaults to the host's display name. */
  title: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((t) => t || undefined),
  /** Optional: defaults to the host's avatar. */
  coverUrl: z.url().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
});

export const roomPassword = z.string().regex(/^\d{4,6}$/, 'Password must be 4–6 digits');

export const liveChatInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(300),
    replyToId: objectIdHex.optional(),
  }),
  z.object({
    type: z.literal('voice'),
    voiceUrl: z.url().max(500),
    durationSec: z.number().int().min(1).max(60),
    replyToId: objectIdHex.optional(),
  }),
]);

export type LiveRole = 'host' | 'moderator' | 'guest' | 'audience';
export type SeatAction =
  'remove' | 'mute' | 'unmute' | 'camera_off' | 'camera_on' | 'lock' | 'unlock';

/** Viewers shown as avatars in the room's top bar. */
const TOP_VIEWERS = 3;

/** Upload folder for in-room voice messages; a sent voice URL must point into the sender's. */
export const VOICE_FOLDER = 'voice';

/**
 * Live rooms (video and audio). Mongo holds room state; LiveKit carries media and the data
 * channel. LiveKit identity == user uid. Every token is minted here with server-authoritative
 * metadata (level, VIP, role), and publish permission is granted only to the host and seated
 * guests.
 */
export class LiveService {
  constructor(private readonly ctx: Ctx) {}

  async get(roomId: ObjectId): Promise<LiveRoomDoc> {
    const room = await this.ctx.col.liveRooms.findOne({ _id: roomId });
    if (!room) throw notFound('Live room');
    return room;
  }

  async getLive(roomId: ObjectId): Promise<LiveRoomDoc> {
    const room = await this.get(roomId);
    if (room.status !== 'live') throw new AppError(410, 'room_ended', 'This live has ended');
    return room;
  }

  async detail(roomId: ObjectId) {
    const room = await this.get(roomId);
    const briefs = await this.ctx.services.users.briefs([
      room.hostId,
      ...room.moderatorIds,
      ...room.seats.map((s) => s.userId).filter((u): u is string => Boolean(u)),
    ]);
    return toRoomDetail(room, briefs.get(room.hostId), briefs);
  }

  roleOf(room: LiveRoomDoc, uid: string): LiveRole {
    if (room.hostId === uid) return 'host';
    if (room.seats.some((s) => s.index > 0 && s.userId === uid)) return 'guest';
    if (room.moderatorIds.includes(uid)) return 'moderator';
    return 'audience';
  }

  /** Push the directory card (lock, title, PK badge) to home screens subscribed to `rooms`. */
  async publishDirectory(roomId: ObjectId): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne({ _id: roomId, status: 'live' });
    if (!room) return;
    const host = (await this.ctx.services.users.briefs([room.hostId])).get(room.hostId);
    this.ctx.realtime.toRoom(
      SOCKET.namespaces.app,
      'rooms',
      SOCKET.app.roomUpserted,
      toLiveRoom(room, host),
    );
  }

  /** Re-mint a connected participant's publish grant and role metadata after a role change. */
  private async syncParticipant(room: LiveRoomDoc, uid: string, role: LiveRole): Promise<void> {
    const { metadata } = await this.metadataFor(uid, role);
    await this.ctx.livekit
      .updateParticipant(room.livekitRoom, uid, {
        canPublish: role === 'host' || role === 'guest',
        metadata,
      })
      // Not connected right now: the next /join mints a token with the new role.
      .catch(() => undefined);
  }

  private async metadataFor(uid: string, role: LiveRole) {
    const user = await this.ctx.services.users.get(uid);
    const now = this.ctx.clock.now();
    return {
      user,
      metadata: {
        uid: user._id,
        shortId: user.shortId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        level: user.level.level,
        vipTier: activeVipTier(user.vip, now),
        frameUrl: user.equipped.frameUrl,
        role,
        isAdmin: Boolean(user.adminRole),
      },
    };
  }

  private async tokenFor(room: LiveRoomDoc, uid: string, role: LiveRole) {
    const { user, metadata } = await this.metadataFor(uid, role);
    const token = await this.ctx.livekit.createToken({
      room: room.livekitRoom,
      identity: uid,
      name: user.displayName,
      canPublish: role === 'host' || role === 'guest',
      metadata,
    });
    return { token, url: this.ctx.livekit.url, identity: uid, role, metadata };
  }

  private async resume(room: LiveRoomDoc) {
    await this.ctx.col.liveRooms.updateOne(
      { _id: room._id },
      { $set: { lastHeartbeatAt: this.ctx.clock.now() } },
    );
    return {
      room: await this.detail(room._id),
      credentials: await this.tokenFor(room, room.hostId, 'host'),
      resumed: true,
    };
  }

  /** Go live. If the host already has a live room it is resumed (app crash / reconnect). */
  async start(hostId: string, input: z.infer<typeof startLiveInput>) {
    const features = await this.ctx.services.config.get('features');
    if (input.type === 'audio' && !features.audioRoomsEnabled)
      throw forbidden('Audio rooms are disabled');
    const existing = await this.ctx.col.liveRooms.findOne({ hostId, status: 'live' });
    if (existing) return this.resume(existing);

    const host = await this.ctx.services.users.get(hostId);
    // Display names are moderated when set, so only a user-typed title needs checking here.
    const title = input.title
      ? await this.ctx.services.moderation.assertClean(input.title, 'title')
      : host.displayName.slice(0, 60);
    const liveCfg = await this.ctx.services.config.get('live');
    const seatCount = input.type === 'audio' ? liveCfg.audioSeatCount : liveCfg.videoSeatCount;
    const seats: SeatDoc[] = Array.from({ length: seatCount }, (_, index) => ({
      index,
      userId: index === 0 ? hostId : null,
      muted: false,
      videoMuted: false,
      locked: false,
    }));
    const now = this.ctx.clock.now();
    const room: LiveRoomDoc = {
      _id: new ObjectId(),
      hostId,
      type: input.type,
      status: 'live',
      title,
      // Snapshot the avatar so lists stay stable if the host changes it mid-live.
      coverUrl: input.coverUrl ?? host.avatarUrl ?? null,
      tags: input.tags,
      country: host.country,
      livekitRoom: `bb_${hostId}_${now.getTime()}`,
      viewerCount: 0,
      peakViewers: 0,
      giftBeans: 0,
      giftCount: 0,
      moderatorIds: [],
      seats,
      pkBattleId: null,
      backgroundUrl: null,
      locked: false,
      passwordHash: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
      endReason: null,
      endedBy: null,
    };
    try {
      await this.ctx.col.liveRooms.insertOne(room);
    } catch (err) {
      // Lost a race with a concurrent start: resume whichever room won.
      const winner = isDuplicateKeyError(err)
        ? await this.ctx.col.liveRooms.findOne({ hostId, status: 'live' })
        : null;
      if (winner) return this.resume(winner);
      throw err;
    }
    await this.ctx.col.users.updateOne({ _id: hostId }, { $set: { liveRoomId: room._id } });

    const detail = await this.detail(room._id);
    await this.publishDirectory(room._id);
    if (liveCfg.followerPushOnGoLive) {
      await this.ctx.jobs.enqueue('push.followers', { hostId, roomId: String(room._id) });
    }
    return { room: detail, credentials: await this.tokenFor(room, hostId, 'host'), resumed: false };
  }

  /**
   * Viewer join: checks bans, blocks and the room lock, then returns a subscribe-only token
   * (publish if seated). Staff, moderators and seated guests pass a lock; anyone else needs the
   * password, when the host set one.
   */
  async join(roomId: ObjectId, uid: string, opts: { password?: string; isStaff?: boolean } = {}) {
    const room = await this.getLive(roomId);
    if (room.hostId === uid)
      return {
        room: await this.detail(roomId),
        credentials: await this.tokenFor(room, uid, 'host'),
      };

    const now = this.ctx.clock.now();
    const ban = await this.ctx.col.roomBans.findOne({ hostId: room.hostId, userId: uid });
    if (ban && (!ban.until || ban.until > now)) {
      throw new AppError(403, 'room_banned', 'You were removed from this live', {
        until: ban.until,
      });
    }
    if (await this.ctx.services.users.isBlockedEitherWay(uid, room.hostId))
      throw forbidden('You cannot join this live');

    const role = this.roleOf(room, uid);
    if (room.locked && role === 'audience' && !opts.isStaff) {
      const hasPassword = Boolean(room.passwordHash);
      if (!room.passwordHash || !opts.password)
        throw new AppError(403, 'room_locked', 'This live is locked', { hasPassword });
      if (!(await verifyPassword(opts.password, room.passwordHash)))
        throw new AppError(403, 'wrong_password', 'Wrong password', { hasPassword });
    }
    const credentials = await this.tokenFor(room, uid, role);

    // Entry banner (VIP / entry animation) for everyone in the room.
    const entry = await this.ctx.services.store.entryAnimationFor(uid);
    if (credentials.metadata.vipTier > 0 || entry) {
      void this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.entry, {
          user: credentials.metadata,
          animation: entry,
        })
        .catch(() => undefined);
    }
    return { room: await this.detail(roomId), credentials };
  }

  async heartbeat(roomId: ObjectId, hostId: string): Promise<void> {
    const res = await this.ctx.col.liveRooms.updateOne(
      { _id: roomId, hostId, status: 'live' },
      { $set: { lastHeartbeatAt: this.ctx.clock.now() } },
    );
    if (!res.matchedCount) throw new AppError(410, 'room_ended', 'This live has ended');
  }

  async update(
    roomId: ObjectId,
    hostId: string,
    patch: { title?: string; backgroundUrl?: string | null; coverUrl?: string | null },
  ) {
    const $set: Partial<LiveRoomDoc> = {};
    if (patch.title !== undefined)
      $set.title = await this.ctx.services.moderation.assertClean(patch.title, 'title');
    if (patch.backgroundUrl !== undefined) $set.backgroundUrl = patch.backgroundUrl;
    if (patch.coverUrl !== undefined) $set.coverUrl = patch.coverUrl;
    const res = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, hostId, status: 'live' },
      { $set },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Your live room');
    await this.broadcastSystem(res, {
      kind: 'room_updated',
      title: res.title,
      coverUrl: res.coverUrl,
      backgroundUrl: res.backgroundUrl,
    });
    await this.publishDirectory(roomId);
    return this.detail(roomId);
  }

  /**
   * Host-only room lock. A locked room admits no new viewers; with a password, viewers who know
   * it still can. People already inside are not affected. Unlocking clears the password.
   */
  async setLock(roomId: ObjectId, hostId: string, locked: boolean, password: string | null) {
    const passwordHash = locked && password ? await hashPassword(password) : null;
    const res = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, hostId, status: 'live' },
      { $set: { locked, passwordHash } },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Your live room');
    await this.broadcastSystem(res, { kind: 'lock', locked, hasPassword: Boolean(passwordHash) });
    await this.publishDirectory(roomId);
    return this.detail(roomId);
  }

  /**
   * End a room. Conditional on `status: 'live'`, so concurrent enders (host, sweeper, webhook,
   * admin) are safe — exactly one wins and runs the side effects.
   */
  async end(
    roomId: ObjectId,
    reason: NonNullable<LiveRoomDoc['endReason']>,
    by: string | null,
  ): Promise<LiveRoomDoc | null> {
    const now = this.ctx.clock.now();
    const room = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live' },
      { $set: { status: 'ended', endedAt: now, endReason: reason, endedBy: by, viewerCount: 0 } },
      { returnDocument: 'after' },
    );
    if (!room) return null;

    const seconds = Math.max(0, Math.round((now.getTime() - room.startedAt.getTime()) / 1000));
    const host = await this.ctx.col.users.findOneAndUpdate(
      { _id: room.hostId, liveRoomId: room._id },
      { $set: { liveRoomId: null }, $inc: { 'stats.liveSeconds': seconds } },
      { returnDocument: 'after', projection: { agencyId: 1 } },
    );
    if (host?.agencyId) {
      await this.ctx.services.agencies
        .recordLiveTime(host.agencyId, room.hostId, seconds)
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'agency live time failed'));
    }
    if (room.pkBattleId) {
      await this.ctx.services.pk
        .forfeitForHost(room.pkBattleId, room.hostId)
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'pk forfeit failed'));
    }
    await Promise.all([
      this.ctx.col.roomPresence.deleteMany({ roomId: room._id }),
      this.ctx.col.seatRequests.updateMany(
        { roomId: room._id, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ),
    ]);
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.roomEnded, { roomId: String(room._id), reason })
      .catch(() => undefined);
    await this.ctx.livekit.deleteRoom(room.livekitRoom).catch(() => undefined);
    this.ctx.realtime.toRoom(SOCKET.namespaces.app, 'rooms', SOCKET.app.roomEnded, {
      id: String(room._id),
    });
    return room;
  }

  async endByHost(roomId: ObjectId, hostId: string) {
    const room = await this.get(roomId);
    if (room.hostId !== hostId) throw forbidden('Only the host can end this live');
    const ended = (await this.end(roomId, 'host', hostId)) ?? room;
    return {
      durationSec: Math.round(
        ((ended.endedAt ?? this.ctx.clock.now()).getTime() - ended.startedAt.getTime()) / 1000,
      ),
      peakViewers: ended.peakViewers,
      giftBeans: ended.giftBeans,
      giftCount: ended.giftCount,
    };
  }

  async endActiveRoomFor(
    uid: string,
    reason: NonNullable<LiveRoomDoc['endReason']>,
    by: string,
  ): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { hostId: uid, status: 'live' },
      { projection: { _id: 1 } },
    );
    if (room) await this.end(room._id, reason, by);
  }

  // ── Directory ───────────────────────────────────────────────────────────────

  async list(opts: {
    type?: RoomType;
    tab: 'popular' | 'new' | 'following' | 'nearby';
    viewerUid: string;
    country?: string | null;
    page: number;
    pageSize: number;
  }) {
    const q: Filter<LiveRoomDoc> = { status: 'live' };
    if (opts.type) q.type = opts.type;
    if (opts.tab === 'nearby' && opts.country) q.country = opts.country;
    if (opts.tab === 'following') {
      const following = await this.ctx.col.follows
        .find({ followerId: opts.viewerUid }, { projection: { followeeId: 1 } })
        .limit(2000)
        .toArray();
      q.hostId = { $in: following.map((f) => f.followeeId) };
    }
    const blocked = await this.ctx.col.blocks
      .find({ $or: [{ blockerId: opts.viewerUid }, { blockedId: opts.viewerUid }] })
      .limit(1000)
      .toArray();
    if (blocked.length) {
      const hidden = blocked.map((b) =>
        b.blockerId === opts.viewerUid ? b.blockedId : b.blockerId,
      );
      q.hostId = q.hostId
        ? { $in: (q.hostId as { $in: string[] }).$in.filter((h) => !hidden.includes(h)) }
        : { $nin: hidden };
    }
    const sort: Sort = opts.tab === 'new' ? { startedAt: -1 } : { viewerCount: -1, startedAt: -1 };
    const [rooms, total] = await Promise.all([
      this.ctx.col.liveRooms
        .find(q)
        .sort(sort)
        .skip((opts.page - 1) * opts.pageSize)
        .limit(opts.pageSize)
        .toArray(),
      this.ctx.col.liveRooms.countDocuments(q),
    ]);
    const briefs = await this.ctx.services.users.briefs(rooms.map((r) => r.hostId));
    return {
      items: rooms.map((r) => toLiveRoom(r, briefs.get(r.hostId))),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async viewers(roomId: ObjectId, limit = 100) {
    const rows = await this.ctx.col.roomPresence
      .find({ roomId })
      .sort({ joinedAt: 1 })
      .limit(limit)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.identity));
    return [...briefs.values()].sort((a, b) => b.vipTier - a.vipTier || b.level - a.level);
  }

  async history(hostId: string, page: number, pageSize: number) {
    const q: Filter<LiveRoomDoc> = { hostId, status: 'ended' };
    const [rooms, total, totals] = await Promise.all([
      this.ctx.col.liveRooms
        .find(q)
        .sort({ startedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.liveRooms.countDocuments(q),
      this.ctx.col.liveRooms
        .aggregate<{ seconds: number; beans: number }>([
          { $match: q },
          {
            $group: {
              _id: null,
              seconds: { $sum: { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 1000] } },
              beans: { $sum: '$giftBeans' },
            },
          },
        ])
        .toArray(),
    ]);
    return {
      items: rooms.map((r) => ({
        id: String(r._id),
        type: r.type,
        title: r.title,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationSec: r.endedAt
          ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
          : 0,
        peakViewers: r.peakViewers,
        giftBeans: r.giftBeans,
        endReason: r.endReason,
      })),
      total,
      page,
      pageSize,
      totals: { seconds: Math.round(totals[0]?.seconds ?? 0), beans: totals[0]?.beans ?? 0 },
    };
  }

  // ── Moderation ──────────────────────────────────────────────────────────────

  private async assertCanModerate(
    room: LiveRoomDoc,
    actorUid: string,
    actorIsAdmin: boolean,
  ): Promise<void> {
    if (actorIsAdmin || room.hostId === actorUid || room.moderatorIds.includes(actorUid)) return;
    throw forbidden('Only the host or a room moderator can do that');
  }

  async kick(
    roomId: ObjectId,
    actor: { uid: string; isAdmin: boolean },
    targetUid: string,
    banMinutes: number | null,
  ): Promise<void> {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    if (targetUid === room.hostId) throw badRequest('The host cannot be removed');
    if (room.moderatorIds.includes(targetUid) && room.hostId !== actor.uid && !actor.isAdmin) {
      throw forbidden('Moderators cannot remove other moderators');
    }
    const now = this.ctx.clock.now();
    await this.ctx.col.roomBans.updateOne(
      { hostId: room.hostId, userId: targetUid },
      {
        $set: {
          until: banMinutes === null ? null : addSeconds(now, banMinutes * 60),
          by: actor.uid,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    // A removed moderator loses the role too; otherwise they could rejoin past the lock.
    if (room.moderatorIds.includes(targetUid)) {
      await this.ctx.col.liveRooms.updateOne(
        { _id: room._id },
        { $pull: { moderatorIds: targetUid } },
      );
      await this.broadcastSystem(room, { kind: 'moderator', uid: targetUid, enabled: false });
    }
    await this.vacateSeatOf(room, targetUid);
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.kick, { uid: targetUid, by: actor.uid })
      .catch(() => undefined);
    await this.ctx.livekit.removeParticipant(room.livekitRoom, targetUid).catch(() => undefined);
  }

  async unbanFromRoom(hostId: string, targetUid: string): Promise<void> {
    await this.ctx.col.roomBans.deleteOne({ hostId, userId: targetUid });
  }

  async roomBans(hostId: string) {
    const rows = await this.ctx.col.roomBans
      .find({ hostId })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      until: r.until,
      createdAt: r.createdAt,
    }));
  }

  /** Host appoints or removes a room admin (moderator). */
  async setModerator(
    roomId: ObjectId,
    hostId: string,
    uid: string,
    enabled: boolean,
  ): Promise<void> {
    if (uid === hostId) throw badRequest('The host is already in charge');
    if (enabled) await this.ctx.services.users.get(uid);
    const room = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, hostId, status: 'live' },
      enabled ? { $addToSet: { moderatorIds: uid } } : { $pull: { moderatorIds: uid } },
      { returnDocument: 'after' },
    );
    if (!room) throw notFound('Your live room');
    await this.syncParticipant(room, uid, this.roleOf(room, uid));
    const user = (await this.ctx.services.users.briefs([uid])).get(uid) ?? null;
    await this.broadcastSystem(room, { kind: 'moderator', uid, enabled, user });
  }

  private async assertNotBanned(room: LiveRoomDoc, uid: string): Promise<void> {
    const ban = await this.ctx.col.roomBans.findOne({ hostId: room.hostId, userId: uid });
    if (ban && (!ban.until || ban.until > this.ctx.clock.now()))
      throw forbidden('You were removed from this live');
  }

  /**
   * In-room chat. Goes through the API (not client-to-client data) so every message is
   * moderated, ban-checked and attributed with server-minted identity, then fanned out on the
   * LiveKit data channel. Messages are kept briefly (TTL) so replies, deletes and reports can
   * reference them.
   */
  async chat(roomId: ObjectId, uid: string, input: z.infer<typeof liveChatInput>) {
    const room = await this.getLive(roomId);
    await this.assertNotBanned(room, uid);
    let text = '';
    let voice: LiveMessageDoc['voice'] = null;
    if (input.type === 'text') {
      text = await this.ctx.services.moderation.assertClean(input.text, 'chat');
    } else {
      if (!(await this.ctx.storage.isOwnUpload(input.voiceUrl, VOICE_FOLDER, uid)))
        throw badRequest('Voice messages must be uploaded through the app');
      voice = { url: input.voiceUrl, durationSec: input.durationSec };
    }
    let replyTo: LiveMessageDoc['replyTo'] = null;
    if (input.replyToId) {
      const target = await this.ctx.col.liveMessages.findOne({
        _id: new ObjectId(input.replyToId),
        roomId,
        deletedAt: null,
      });
      if (!target) throw notFound('Message');
      const author = (await this.ctx.services.users.briefs([target.userId])).get(target.userId);
      replyTo = {
        id: String(target._id),
        userId: target.userId,
        displayName: author?.displayName ?? 'User',
        text: target.type === 'voice' ? '🎤 Voice message' : target.text.slice(0, 80),
      };
    }
    const now = this.ctx.clock.now();
    const doc: LiveMessageDoc = {
      _id: new ObjectId(),
      roomId,
      userId: uid,
      type: input.type,
      text,
      voice,
      replyTo,
      createdAt: now,
      deletedAt: null,
    };
    await this.ctx.col.liveMessages.insertOne(doc);
    const { metadata } = await this.metadataFor(uid, this.roleOf(room, uid));
    const message = {
      id: String(doc._id),
      type: doc.type,
      text,
      voice,
      replyTo,
      user: metadata,
      at: now.toISOString(),
    };
    await this.ctx.livekit.sendData(room.livekitRoom, LIVEKIT_TOPICS.chat, message);
    return message;
  }

  /** The author, the host, a room moderator or staff can remove a chat message for everyone. */
  async deleteChat(
    roomId: ObjectId,
    actor: { uid: string; isAdmin: boolean },
    messageId: ObjectId,
  ): Promise<void> {
    const room = await this.getLive(roomId);
    const msg = await this.ctx.col.liveMessages.findOne({ _id: messageId, roomId });
    if (!msg) throw notFound('Message');
    if (msg.userId !== actor.uid) await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    const res = await this.ctx.col.liveMessages.updateOne(
      { _id: messageId, deletedAt: null },
      { $set: { deletedAt: this.ctx.clock.now() } },
    );
    if (res.modifiedCount)
      await this.broadcastSystem(room, { kind: 'chat_deleted', id: String(messageId) });
  }

  /** Heart reactions. Rate-limited per user at the route; clients coalesce the animation. */
  async react(roomId: ObjectId, uid: string, count: number): Promise<void> {
    const room = await this.getLive(roomId);
    await this.assertNotBanned(room, uid);
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.reaction, { uid, count })
      .catch(() => undefined);
  }

  async broadcastSystem(room: LiveRoomDoc, payload: Record<string, unknown>): Promise<void> {
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.system, payload)
      .catch(() => undefined);
  }

  // ── Seats (guests in video rooms, speakers in audio rooms) ──────────────────────

  private async broadcastSeats(roomId: ObjectId): Promise<void> {
    const detail = await this.detail(roomId);
    await this.ctx.livekit
      .sendData(detail.livekitRoom, LIVEKIT_TOPICS.seats, { kind: 'seats', seats: detail.seats })
      .catch(() => undefined);
  }

  /** Seat-request bookkeeping goes to the requester, the host and the room moderators. */
  private async notifySeatStaff(
    room: LiveRoomDoc,
    payload: Record<string, unknown>,
    extra: string[] = [],
  ): Promise<void> {
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.seats, payload, [
        room.hostId,
        ...room.moderatorIds,
        ...extra,
      ])
      .catch(() => undefined);
  }

  /** Atomically take a free seat. `index` null = first free seat. */
  private async occupySeat(room: LiveRoomDoc, uid: string, index: number | null): Promise<number> {
    const candidates = room.seats.filter(
      (s) => s.index > 0 && !s.userId && !s.locked && (index === null || s.index === index),
    );
    for (const seat of candidates) {
      const updated = await this.ctx.col.liveRooms.findOneAndUpdate(
        {
          _id: room._id,
          status: 'live',
          'seats.userId': { $ne: uid },
          seats: { $elemMatch: { index: seat.index, userId: null, locked: false } },
        },
        {
          $set: {
            'seats.$.userId': uid,
            'seats.$.muted': false,
            'seats.$.videoMuted': false,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated) {
        await this.syncParticipant(updated, uid, 'guest');
        await this.broadcastSeats(room._id);
        return seat.index;
      }
    }
    throw new AppError(409, 'seat_unavailable', 'No seat available');
  }

  private async vacateSeatOf(room: LiveRoomDoc, uid: string): Promise<boolean> {
    const updated = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: room._id, seats: { $elemMatch: { userId: uid, index: { $gt: 0 } } } },
      { $set: { 'seats.$.userId': null, 'seats.$.muted': false, 'seats.$.videoMuted': false } },
      { returnDocument: 'after' },
    );
    if (!updated) return false;
    await this.syncParticipant(updated, uid, this.roleOf(updated, uid));
    await this.broadcastSeats(room._id);
    return true;
  }

  async requestSeat(roomId: ObjectId, uid: string) {
    const room = await this.getLive(roomId);
    if (room.seats.some((s) => s.userId === uid)) throw badRequest('You are already on a seat');
    await this.assertNotBanned(room, uid);
    const ttl = (await this.ctx.services.config.get('live')).seatRequestTtlSec;
    const now = this.ctx.clock.now();
    const expiresAt = addSeconds(now, ttl);
    await this.ctx.col.seatRequests.updateOne(
      { roomId, userId: uid, kind: 'request', status: 'pending' },
      {
        $set: { expiresAt },
        $setOnInsert: { roomId, userId: uid, kind: 'request', status: 'pending', createdAt: now },
      },
      { upsert: true },
    );
    const { metadata } = await this.metadataFor(uid, 'audience');
    await this.notifySeatStaff(room, {
      kind: 'request',
      user: metadata,
      expiresAt: expiresAt.toISOString(),
    });
    return { expiresAt };
  }

  async cancelSeatRequest(roomId: ObjectId, uid: string): Promise<void> {
    const room = await this.getLive(roomId);
    const res = await this.ctx.col.seatRequests.updateOne(
      { roomId, userId: uid, kind: 'request', status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    if (res.modifiedCount)
      await this.notifySeatStaff(room, { kind: 'request_resolved', uid, accepted: false });
  }

  async seatRequests(roomId: ObjectId, actorUid: string, actorIsAdmin = false) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actorUid, actorIsAdmin);
    const rows = await this.ctx.col.seatRequests
      .find({
        roomId,
        kind: 'request',
        status: 'pending',
        expiresAt: { $gt: this.ctx.clock.now() },
      })
      .sort({ createdAt: 1 })
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Host/moderator accepts or rejects a pending request. */
  async decideSeat(
    roomId: ObjectId,
    actor: { uid: string; isAdmin: boolean },
    uid: string,
    accept: boolean,
    index: number | null,
  ) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    const now = this.ctx.clock.now();
    const req = await this.ctx.col.seatRequests.findOneAndUpdate(
      { roomId, userId: uid, kind: 'request', status: 'pending', expiresAt: { $gt: now } },
      { $set: { status: accept ? 'accepted' : 'rejected' } },
    );
    if (!req) throw notFound('Pending seat request');
    if (!accept) {
      await this.notifySeatStaff(room, { kind: 'request_resolved', uid, accepted: false }, [uid]);
      return { seated: false as const };
    }
    try {
      const seated = await this.occupySeat(room, uid, index);
      await this.notifySeatStaff(room, { kind: 'request_resolved', uid, accepted: true }, [uid]);
      return { seated: true as const, index: seated };
    } catch (err) {
      // No free seat: put the request back so it can be accepted once one frees up.
      await this.ctx.col.seatRequests
        .updateOne({ _id: req._id, status: 'accepted' }, { $set: { status: 'pending' } })
        .catch(() => undefined);
      throw err;
    }
  }

  async inviteToSeat(roomId: ObjectId, actor: { uid: string; isAdmin: boolean }, uid: string) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    if (room.seats.some((s) => s.userId === uid)) throw badRequest('Already on a seat');
    const ttl = (await this.ctx.services.config.get('live')).seatRequestTtlSec;
    const now = this.ctx.clock.now();
    const expiresAt = addSeconds(now, ttl);
    await this.ctx.col.seatRequests.updateOne(
      { roomId, userId: uid, kind: 'invite', status: 'pending' },
      {
        $set: { expiresAt },
        $setOnInsert: { roomId, userId: uid, kind: 'invite', status: 'pending', createdAt: now },
      },
      { upsert: true },
    );
    const { metadata } = await this.metadataFor(actor.uid, this.roleOf(room, actor.uid));
    await this.ctx.livekit
      .sendData(
        room.livekitRoom,
        LIVEKIT_TOPICS.seats,
        { kind: 'invite', from: metadata, expiresAt: expiresAt.toISOString() },
        [uid],
      )
      .catch(() => undefined);
  }

  async respondToInvite(roomId: ObjectId, uid: string, accept: boolean) {
    const room = await this.getLive(roomId);
    const req = await this.ctx.col.seatRequests.findOneAndUpdate(
      {
        roomId,
        userId: uid,
        kind: 'invite',
        status: 'pending',
        expiresAt: { $gt: this.ctx.clock.now() },
      },
      { $set: { status: accept ? 'accepted' : 'rejected' } },
    );
    if (!req) throw notFound('Pending invitation');
    const { metadata } = await this.metadataFor(uid, 'audience');
    if (!accept) {
      await this.notifySeatStaff(room, { kind: 'invite_declined', user: metadata });
      return { seated: false as const };
    }
    return { seated: true as const, index: await this.occupySeat(room, uid, null) };
  }

  async leaveSeat(roomId: ObjectId, uid: string): Promise<void> {
    const room = await this.getLive(roomId);
    if (!(await this.vacateSeatOf(room, uid))) throw badRequest('You are not on a seat');
  }

  async manageSeat(
    roomId: ObjectId,
    actor: { uid: string; isAdmin: boolean },
    index: number,
    action: SeatAction,
  ) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    if (index === 0) throw badRequest('The host seat cannot be changed');
    const seat = room.seats.find((s) => s.index === index);
    if (!seat) throw notFound('Seat');
    if (
      seat.userId &&
      room.moderatorIds.includes(actor.uid) &&
      room.moderatorIds.includes(seat.userId)
    )
      throw forbidden('Moderators cannot manage other moderators');
    switch (action) {
      case 'remove':
        if (seat.userId) await this.vacateSeatOf(room, seat.userId);
        return;
      case 'lock':
        if (seat.userId) await this.vacateSeatOf(room, seat.userId);
        break;
      case 'mute':
      case 'unmute':
      case 'camera_off':
      case 'camera_on': {
        if (!seat.userId) throw badRequest('The seat is empty');
        const audio = action === 'mute' || action === 'unmute';
        const muted = action === 'mute' || action === 'camera_off';
        // Enforced on the SFU. Unmuting stays with the guest (LiveKit only lets a server unmute
        // when remote unmute is enabled), whose client re-enables the track when the flag clears.
        if (muted) {
          await this.ctx.livekit
            .muteTracks(room.livekitRoom, seat.userId, audio ? 'audio' : 'video', true)
            .catch((err: unknown) => this.ctx.log.warn({ err }, 'seat mute failed'));
        }
        break;
      }
    }
    const $set: Record<string, boolean> =
      action === 'lock' || action === 'unlock'
        ? { 'seats.$.locked': action === 'lock' }
        : action === 'mute' || action === 'unmute'
          ? { 'seats.$.muted': action === 'mute' }
          : { 'seats.$.videoMuted': action === 'camera_off' };
    await this.ctx.col.liveRooms.updateOne({ _id: room._id, 'seats.index': index }, { $set });
    await this.broadcastSeats(room._id);
  }

  // ── LiveKit webhooks & sweeping ────────────────────────────────────────────────

  async onParticipantJoined(livekitRoom: string, identity: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom, status: 'live' },
      { projection: { _id: 1, hostId: 1 } },
    );
    if (!room || identity === room.hostId) return;
    const res = await this.ctx.col.roomPresence.updateOne(
      { roomId: room._id, identity },
      { $setOnInsert: { roomId: room._id, identity, joinedAt: this.ctx.clock.now() } },
      { upsert: true },
    );
    // Only a first delivery announces the join; redelivered webhooks just recount.
    await this.syncViewerCount(room._id, res.upsertedCount ? identity : undefined);
  }

  async onParticipantLeft(livekitRoom: string, identity: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom },
      { projection: { _id: 1, hostId: 1, status: 1, seats: 1, livekitRoom: 1 } },
    );
    if (!room) return;
    await this.ctx.col.roomPresence.deleteOne({ roomId: room._id, identity });
    if (room.status === 'live') {
      if (identity !== room.hostId)
        await this.vacateSeatOf(room as LiveRoomDoc, identity).catch(() => false);
      await this.syncViewerCount(room._id);
    }
  }

  /**
   * Viewer count is recomputed from presence rows, so webhook redelivery cannot skew it. The room
   * gets the new count and its top viewers, so clients don't poll for them.
   */
  private async syncViewerCount(roomId: ObjectId, joinedUid?: string): Promise<void> {
    const count = await this.ctx.col.roomPresence.countDocuments({ roomId });
    const room = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live' },
      [{ $set: { viewerCount: count, peakViewers: { $max: ['$peakViewers', count] } } }],
      { returnDocument: 'after', projection: { livekitRoom: 1 } },
    );
    if (!room) return;
    const top = (await this.viewers(roomId, 50)).slice(0, TOP_VIEWERS);
    const joined = joinedUid
      ? ((await this.ctx.services.users.briefs([joinedUid])).get(joinedUid) ?? null)
      : null;
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.system, { kind: 'viewers', count, top, joined })
      .catch(() => undefined);
  }

  async onRoomFinished(livekitRoom: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom, status: 'live' },
      { projection: { _id: 1 } },
    );
    if (room) await this.end(room._id, 'webhook', null);
  }

  /** Close rooms whose host stopped heart-beating (app killed, network lost). */
  async sweepStale(): Promise<number> {
    const { staleAfterSec } = await this.ctx.services.config.get('live');
    const cutoff = addSeconds(this.ctx.clock.now(), -staleAfterSec);
    const stale = await this.ctx.col.liveRooms
      .find({ status: 'live', lastHeartbeatAt: { $lt: cutoff } }, { projection: { _id: 1 } })
      .limit(500)
      .toArray();
    let ended = 0;
    for (const r of stale) if (await this.end(r._id, 'stale', null)) ended++;
    // Expire seat requests/invites past their TTL.
    await this.ctx.col.seatRequests.updateMany(
      { status: 'pending', expiresAt: { $lte: this.ctx.clock.now() } },
      { $set: { status: 'expired' } },
    );
    return ended;
  }
}
