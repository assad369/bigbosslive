import { ObjectId, type Filter, type Sort } from 'mongodb';
import { z } from 'zod';
import { LIVEKIT_TOPICS, ROOM_TYPES, SOCKET, type RoomType } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type {
  GiftDoc,
  GiftTransactionDoc,
  LiveGiftMessage,
  LiveMessageDoc,
  LiveRoomDoc,
  SeatDoc,
  UserDoc,
} from '../../db/schema.js';
import {
  AppError,
  badRequest,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { addSeconds } from '../../lib/time.js';
import {
  activeBadge,
  activeVipTier,
  resolveFrame,
  resolveRoomBackground,
} from '../users/users.presenter.js';
import { isPlatformModerator, isProtected } from '../moderation/authority.js';
import { effectiveBackground, toLiveRoom, toRoomDetail } from './live.presenter.js';

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

/**
 * Who is acting in a room. `isAdmin`: may moderate any live (a platform moderator, or staff
 * with `live.moderate`; see `canModerateLive`). `isStaff`: dashboard staff with
 * `live.moderate`, the only people who may act on a protected account (staff or platform
 * moderators).
 */
export interface LiveActor {
  uid: string;
  isAdmin: boolean;
  isStaff?: boolean;
}
export type SeatAction =
  'remove' | 'mute' | 'unmute' | 'camera_off' | 'camera_on' | 'lock' | 'unlock';

/** Viewers shown as avatars in the room's top bar (the host has its own pill). */
const TOP_VIEWERS = 4;

/** How long a seated guest may be missing from LiveKit before `live.sweep` frees the seat. */
const SEAT_ABSENT_GRACE_MS = 20_000;

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
    const seated = room.seats.map((s) => s.userId).filter((u): u is string => Boolean(u));
    const [briefs, balances] = await Promise.all([
      this.ctx.services.users.briefs([room.hostId, ...room.moderatorIds, ...seated]),
      this.seatStats(seated),
    ]);
    return toRoomDetail(
      room,
      briefs.get(room.hostId),
      briefs,
      this.ctx.clock.now(),
      new Map([...balances].map(([uid, s]) => [uid, s.diamonds])),
    );
  }

  /** Diamond balance and level of each uid, for stage tiles. */
  private async seatStats(uids: string[]) {
    const out = new Map<string, { diamonds: number; level: number }>();
    if (!uids.length) return out;
    const rows = await this.ctx.col.users
      .find({ _id: { $in: uids } }, { projection: { 'wallet.diamonds': 1, 'level.level': 1 } })
      .toArray();
    for (const u of rows)
      out.set(u._id, { diamonds: u.wallet?.diamonds ?? 0, level: u.level?.level ?? 0 });
    return out;
  }

  /**
   * Tell each live room where any of `uids` is on a seat (host included) their new diamond
   * balance and level, so stage tiles update at once. Called after a wallet transaction commits;
   * the 30 s detail poll repairs a lost packet.
   */
  async publishSeatBalances(uids: string[]): Promise<void> {
    if (!uids.length) return;
    const rooms = await this.ctx.col.liveRooms
      .find(
        { status: 'live', 'seats.userId': { $in: uids } },
        { projection: { livekitRoom: 1, seats: 1 } },
      )
      .toArray();
    if (!rooms.length) return;
    const stats = await this.seatStats(uids);
    for (const room of rooms) {
      const seated = new Set(room.seats.map((s) => s.userId));
      const users = uids
        .filter((uid) => seated.has(uid) && stats.has(uid))
        .map((uid) => ({ uid, ...stats.get(uid)! }));
      if (!users.length) continue;
      await this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.seats, { kind: 'balances', users })
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'seat balances send failed'));
    }
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

  /**
   * Re-mint a connected participant's publish grant and role metadata after a role change.
   *
   * LiveKit replaces the whole permission, `hidden` included, so it is always stated: a
   * platform moderator who joined hidden stays hidden while in the audience (see
   * {@link hiddenIn}), and is shown while on a seat. Without this, any role change in the room
   * would reveal a watching moderator.
   */
  private async syncParticipant(room: LiveRoomDoc, uid: string, role: LiveRole): Promise<void> {
    const { user, metadata } = await this.metadataFor(uid, role);
    const hidden = await this.hiddenIn(room, user, role);
    await this.ctx.livekit
      .updateParticipant(room.livekitRoom, uid, {
        canPublish: role === 'host' || role === 'guest',
        hidden,
        metadata: hidden ? { ...metadata, stealth: true } : metadata,
      })
      // Not connected right now: the next /join mints a token with the new role.
      .catch(() => undefined);
  }

  /**
   * Whether `user` is hidden in `room` right now: a platform moderator off the stage whose
   * presence row says they connected hidden (stealth). Seated, they are visible; back in the
   * audience, hidden again. Being a room admin never reveals them: only the host and guests,
   * who publish, are always visible. Read from the database, so it survives a redeploy.
   */
  private async hiddenIn(
    room: LiveRoomDoc,
    user: Pick<UserDoc, '_id' | 'platformModerator'>,
    role: LiveRole,
  ): Promise<boolean> {
    if (role === 'host' || role === 'guest' || !isPlatformModerator(user)) return false;
    const row = await this.ctx.col.roomPresence.findOne(
      { roomId: room._id, identity: user._id },
      { projection: { hidden: 1 } },
    );
    return Boolean(row?.hidden);
  }

  /**
   * After a user's identity changed (tier package, frame, entrance or background put on, taken
   * off or expired): re-mint their LiveKit metadata in every room they are in, and refresh the
   * directory card and background of the room they host.
   */
  async refreshIdentity(uid: string): Promise<void> {
    const present = await this.ctx.col.roomPresence
      .find({ identity: uid }, { projection: { roomId: 1 } })
      .toArray();
    const rooms = await this.ctx.col.liveRooms
      .find({
        status: 'live',
        $or: [{ hostId: uid }, { _id: { $in: present.map((p) => p.roomId) } }],
      })
      .toArray();
    for (const room of rooms) {
      await this.syncParticipant(room, uid, this.roleOf(room, uid));
      if (room.hostId === uid) {
        await this.refreshDecorBackground(room);
        await this.publishDirectory(room._id);
      }
    }
  }

  /**
   * {@link refreshIdentity} for many users at once, touching only those who are live or
   * watching a live right now (the rest pick the change up on their next join).
   */
  async refreshIdentities(uids: string[]): Promise<void> {
    const unique = [...new Set(uids)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const [present, hosting] = await Promise.all([
        this.ctx.col.roomPresence.distinct('identity', { identity: { $in: chunk } }),
        this.ctx.col.liveRooms.distinct('hostId', { hostId: { $in: chunk }, status: 'live' }),
      ]);
      for (const uid of new Set([...present, ...hosting])) {
        await this.refreshIdentity(uid).catch((err: unknown) =>
          this.ctx.log.warn({ err, uid }, 'identity refresh failed'),
        );
      }
    }
  }

  /**
   * Keep the host's equipped store background on their live room. Only the snapshot moves; a
   * background the host set for this live (`backgroundUrl`) still wins in the room detail.
   */
  private async refreshDecorBackground(room: LiveRoomDoc): Promise<void> {
    const host = await this.ctx.col.users.findOne(
      { _id: room.hostId },
      { projection: { vip: 1, equipped: 1 } },
    );
    const decor = host ? resolveRoomBackground(host, this.ctx.clock.now()) : null;
    if ((room.decorBackgroundUrl ?? null) === decor) return;
    const res = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: room._id, status: 'live' },
      { $set: { decorBackgroundUrl: decor } },
      { returnDocument: 'after' },
    );
    if (!res) return;
    await this.broadcastSystem(res, {
      kind: 'room_updated',
      title: res.title,
      coverUrl: res.coverUrl,
      backgroundUrl: effectiveBackground(res),
    });
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
        badge: activeBadge(user.vip, now),
        ...resolveFrame(user, now),
        role,
        isAdmin: Boolean(user.adminRole),
      } as Record<string, unknown> & { vipTier: number },
    };
  }

  private async tokenFor(
    room: LiveRoomDoc,
    uid: string,
    role: LiveRole,
    opts: { hidden?: boolean } = {},
  ) {
    const { user, metadata } = await this.metadataFor(uid, role);
    const hidden = Boolean(opts.hidden);
    const meta = hidden ? { ...metadata, stealth: true } : metadata;
    const token = await this.ctx.livekit.createToken({
      room: room.livekitRoom,
      identity: uid,
      name: user.displayName,
      canPublish: role === 'host' || role === 'guest',
      metadata: meta,
      hidden,
    });
    return { token, url: this.ctx.livekit.url, identity: uid, role, metadata: meta };
  }

  private async resume(room: LiveRoomDoc) {
    const host = await this.ctx.services.users.get(room.hostId);
    // Idempotent: re-registers supervision if the first attempt never got through.
    await this.ctx.services.sightguard.startLive(supervised(room));
    await this.ctx.col.liveRooms.updateOne(
      { _id: room._id },
      {
        $set: {
          lastHeartbeatAt: this.ctx.clock.now(),
          hostVipTier: activeVipTier(host.vip, this.ctx.clock.now()),
          decorBackgroundUrl: resolveRoomBackground(host, this.ctx.clock.now()),
        },
      },
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
    const roomId = new ObjectId();
    // Display names are moderated when set, so only a user-typed title needs checking here.
    const title = input.title
      ? await this.ctx.services.moderation.assertClean(input.title, 'title')
      : host.displayName.slice(0, 60);
    if (input.title)
      await this.ctx.services.sightguard.assertText('live_title', input.title, hostId, {
        type: 'live_title',
        roomId: String(roomId),
      });
    if (input.coverUrl && input.coverUrl !== host.avatarUrl)
      await this.assertCover(roomId, hostId, 'coverUrl', input.coverUrl);
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
      _id: roomId,
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
      giftDiamonds: 0,
      giftCount: 0,
      moderatorIds: [],
      seats,
      swappedUid: null,
      pkBattleId: null,
      hostVipTier: activeVipTier(host.vip, now),
      backgroundUrl: null,
      decorBackgroundUrl: resolveRoomBackground(host, now),
      locked: false,
      passwordHash: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
      endReason: null,
      endedBy: null,
      totalJoins: 0,
      uniqueViewers: 0,
      chatMessages: 0,
      reactions: 0,
      summary: null,
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
    await this.ctx.services.sightguard.startLive(supervised(room));

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
   * password, when the host set one. People who moderate any live (`canModerate`: platform
   * moderators, staff with `live.moderate`) also pass the host's room bans and blocks.
   *
   * A platform moderator joins hidden while stealth is on (`stealth: true`): no entrance,
   * no viewer count, no join line. `resume` is a reconnect of someone already watching: no
   * entrance either, or the whole room would see it again after every network drop.
   */
  async join(
    roomId: ObjectId,
    uid: string,
    opts: { password?: string; isStaff?: boolean; canModerate?: boolean; resume?: boolean } = {},
  ) {
    const room = await this.getLive(roomId);
    if (room.hostId === uid)
      return {
        room: await this.detail(roomId),
        credentials: await this.tokenFor(room, uid, 'host'),
        entry: null,
        stealth: false,
      };

    const now = this.ctx.clock.now();
    if (!opts.canModerate) {
      const ban = await this.ctx.col.roomBans.findOne({ hostId: room.hostId, userId: uid });
      if (ban && (!ban.until || ban.until > now)) {
        throw new AppError(403, 'room_banned', 'You were removed from this live', {
          until: ban.until,
        });
      }
      if (await this.ctx.services.users.isBlockedEitherWay(uid, room.hostId))
        throw forbidden('You cannot join this live');
    }

    let role = this.roleOf(room, uid);
    if (room.locked && role === 'audience' && !opts.isStaff && !opts.canModerate) {
      const hasPassword = Boolean(room.passwordHash);
      if (!room.passwordHash || !opts.password)
        throw new AppError(403, 'room_locked', 'This live is locked', { hasPassword });
      if (!(await verifyPassword(opts.password, room.passwordHash)))
        throw new AppError(403, 'wrong_password', 'Wrong password', { hasPassword });
    }
    const user = await this.ctx.services.users.get(uid);
    const stealth =
      role === 'audience' &&
      isPlatformModerator(user) &&
      (await this.ctx.services.config.get('platformModerators')).stealthEnabled;
    // A visible platform moderator is a room admin in every live. A hidden one isn't: the
    // admin list and its announcement would give them away.
    if (role === 'audience' && isPlatformModerator(user) && !stealth) {
      await this.addAutoAdmin(room, uid);
      role = 'moderator';
    }
    const credentials = await this.tokenFor(room, uid, role, { hidden: stealth });

    // Already in the room (a reconnect, or a second join call): no second entrance.
    const watching =
      opts.resume ||
      (await this.ctx.col.roomPresence.countDocuments(
        { roomId: room._id, identity: uid },
        { limit: 1 },
      )) > 0;
    // Entrance for everyone in the room: VIP tiers get a banner, plus an effect when they
    // have one (their equipped entry animation).
    let entry = null;
    if (!stealth && !watching) {
      const effect = await this.ctx.services.store.entryEffectFor(
        uid,
        credentials.metadata.vipTier,
      );
      entry =
        credentials.metadata.vipTier > 0 || effect ? { user: credentials.metadata, effect } : null;
    }
    if (entry) {
      void this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.entry, entry)
        .catch(() => undefined);
    }
    // The broadcast goes out before the joiner connects to LiveKit, so they never receive it:
    // they get the same entrance here and play it themselves once connected.
    return { room: await this.detail(roomId), credentials, entry, stealth };
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
    const current = await this.ctx.col.liveRooms.findOne({ _id: roomId, hostId, status: 'live' });
    if (!current) throw notFound('Your live room');
    const $set: Partial<LiveRoomDoc> = {};
    if (patch.title !== undefined) {
      $set.title = await this.ctx.services.moderation.assertClean(patch.title, 'title');
      if (patch.title !== current.title)
        await this.ctx.services.sightguard.assertText('live_title', patch.title, hostId, {
          type: 'live_title',
          roomId: String(roomId),
        });
    }
    for (const field of ['coverUrl', 'backgroundUrl'] as const) {
      const url = patch[field];
      if (url === undefined) continue;
      if (url && url !== current[field]) await this.assertCover(roomId, hostId, field, url);
      $set[field] = url;
    }
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
      backgroundUrl: effectiveBackground(res),
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
        .recordLiveTime(host.agencyId, room.hostId, room.startedAt, now)
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
    await this.ctx.services.sightguard.endLive(supervised(room));
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
      giftDiamonds: ended.giftDiamonds,
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
    // Popular lists King, then VVIP, then VIP hosts first; within a tier, by audience.
    const sort: Sort =
      opts.tab === 'new'
        ? { startedAt: -1 }
        : opts.tab === 'popular'
          ? { hostVipTier: -1, viewerCount: -1, startedAt: -1 }
          : { viewerCount: -1, startedAt: -1 };
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

  /** People watching, hidden platform moderators left out. */
  async viewers(roomId: ObjectId, limit = 100) {
    const rows = await this.ctx.col.roomPresence
      .find({ roomId, hidden: { $ne: true } })
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
        .aggregate<{ seconds: number; diamonds: number }>([
          { $match: q },
          {
            $group: {
              _id: null,
              seconds: { $sum: { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 1000] } },
              diamonds: { $sum: '$giftDiamonds' },
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
        giftDiamonds: r.giftDiamonds,
        endReason: r.endReason,
      })),
      total,
      page,
      pageSize,
      totals: { seconds: Math.round(totals[0]?.seconds ?? 0), diamonds: totals[0]?.diamonds ?? 0 },
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

  /**
   * Someone who moderates any live, acting in a room they don't host. The route audits what
   * they do. Being one of the room's admins doesn't exempt them: platform moderators are made
   * admins automatically.
   */
  private outsider(room: LiveRoomDoc, actor: LiveActor): boolean {
    return actor.isAdmin && room.hostId !== actor.uid;
  }

  /**
   * Staff and platform moderators can't be removed, muted or have their messages deleted by a
   * host, a room admin or another platform moderator. Only staff may act on them.
   */
  private async assertNotProtected(targetUid: string, actor: LiveActor): Promise<void> {
    if (targetUid === actor.uid || actor.isStaff) return;
    const target = await this.ctx.col.users.findOne(
      { _id: targetUid },
      { projection: { adminRole: 1, platformModerator: 1 } },
    );
    if (target && isProtected(target))
      throw new AppError(
        403,
        'target_protected',
        'Platform moderators and staff can’t be acted on',
      );
  }

  async kick(
    roomId: ObjectId,
    actor: LiveActor,
    targetUid: string,
    banMinutes: number | null,
  ): Promise<{ staffAction: boolean }> {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    if (targetUid === actor.uid) throw badRequest('You cannot remove yourself');
    if (targetUid === room.hostId) throw badRequest('The host cannot be removed');
    if (room.moderatorIds.includes(targetUid) && room.hostId !== actor.uid && !actor.isAdmin) {
      throw forbidden('Moderators cannot remove other moderators');
    }
    await this.assertNotProtected(targetUid, actor);
    await this.evict(room, targetUid, actor.uid, banMinutes);
    return { staffAction: this.outsider(room, actor) };
  }

  /** Room ban, role and seat revoked, then the participant is told and disconnected. */
  private async evict(
    room: LiveRoomDoc,
    targetUid: string,
    by: string,
    banMinutes: number | null,
  ): Promise<void> {
    const now = this.ctx.clock.now();
    await this.ctx.col.roomBans.updateOne(
      { hostId: room.hostId, userId: targetUid },
      {
        $set: {
          until: banMinutes === null ? null : addSeconds(now, banMinutes * 60),
          by,
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
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.kick, { uid: targetUid, by })
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

  /**
   * Appoint or remove a room admin (moderator): the host, or anyone who moderates every live
   * (platform moderators, `live.moderate` staff). Room admins can't appoint. Only staff may take
   * the role from a protected account (staff, platform moderators); anyone may give up their own.
   */
  async setModerator(
    roomId: ObjectId,
    actor: LiveActor,
    uid: string,
    enabled: boolean,
  ): Promise<{ staffAction: boolean }> {
    const current = await this.getLive(roomId);
    const isHost = current.hostId === actor.uid;
    if (!isHost && !actor.isAdmin) throw forbidden('Only the host can appoint room admins');
    if (uid === current.hostId) throw badRequest('The host is already in charge');
    if (enabled) await this.ctx.services.users.get(uid);
    else await this.assertNotProtected(uid, actor);
    const room = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live' },
      enabled ? { $addToSet: { moderatorIds: uid } } : { $pull: { moderatorIds: uid } },
      { returnDocument: 'after' },
    );
    if (!room) throw new AppError(410, 'room_ended', 'This live has ended');
    await this.syncParticipant(room, uid, this.roleOf(room, uid));
    const user = (await this.ctx.services.users.briefs([uid])).get(uid) ?? null;
    await this.broadcastSystem(room, { kind: 'moderator', uid, enabled, user });
    return { staffAction: this.outsider(current, actor) };
  }

  /**
   * A platform moderator visible in a live becomes one of its admins. A no-op when they
   * already are, so a rejoin announces nothing.
   */
  private async addAutoAdmin(room: LiveRoomDoc, uid: string): Promise<void> {
    const updated = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: room._id, status: 'live', moderatorIds: { $ne: uid } },
      { $addToSet: { moderatorIds: uid } },
      { returnDocument: 'after' },
    );
    if (!updated) return;
    const user = (await this.ctx.services.users.briefs([uid])).get(uid) ?? null;
    await this.broadcastSystem(updated, { kind: 'moderator', uid, enabled: true, user });
  }

  /**
   * Take `uid` off a room's admins without a chat line (no `user` in the packet), e.g. a
   * platform moderator going back to hidden. Returns the room as updated, or null.
   */
  private async pullAdminQuietly(roomId: ObjectId, uid: string): Promise<LiveRoomDoc | null> {
    const updated = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live', moderatorIds: uid },
      { $pull: { moderatorIds: uid } },
      { returnDocument: 'after' },
    );
    if (updated) await this.broadcastSystem(updated, { kind: 'moderator', uid, enabled: false });
    return updated;
  }

  /** Someone lost the platform moderator role: they're no longer an admin in any live. */
  async dropRoomAdmin(uid: string): Promise<number> {
    const rooms = await this.ctx.col.liveRooms
      .find({ status: 'live', moderatorIds: uid }, { projection: { _id: 1 } })
      .toArray();
    let dropped = 0;
    for (const { _id } of rooms) {
      const updated = await this.pullAdminQuietly(_id, uid);
      if (!updated) continue;
      dropped++;
      await this.syncParticipant(updated, uid, this.roleOf(updated, uid));
    }
    return dropped;
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
    const messageId = new ObjectId();
    if (input.type === 'text') {
      text = await this.ctx.services.moderation.assertClean(input.text, 'chat');
      await this.ctx.services.sightguard.assertChat(input.text, uid, {
        type: 'live_message',
        roomId: String(roomId),
        messageId: String(messageId),
      });
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
        text: replyPreview(target),
      };
    }
    const now = this.ctx.clock.now();
    const doc: LiveMessageDoc = {
      _id: messageId,
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
    // A lasting count for the post-live summary (messages themselves expire after a week).
    await this.ctx.col.liveRooms.updateOne({ _id: room._id }, { $inc: { chatMessages: 1 } });
    const role = this.roleOf(room, uid);
    const { user, metadata } = await this.metadataFor(uid, role);
    const message = {
      id: String(doc._id),
      type: doc.type,
      text,
      voice,
      replyTo,
      user: metadata,
      at: now.toISOString(),
      // A hidden platform moderator: nobody can find them in the room, so their messages say
      // who they are. Decided here, never by the sender's client.
      mod: await this.hiddenIn(room, user, role),
    };
    await this.ctx.livekit.sendData(room.livekitRoom, LIVEKIT_TOPICS.chat, message);
    return message;
  }

  /**
   * The chat row for a committed room gift, saved like any message so it can be replied to,
   * reported and deleted. Its `_id` is the gift transaction's, so a gift never gets two rows.
   * Returns the message as `chat()` does; the caller sends it inside the `bb.gift` packet.
   */
  async giftMessage(
    room: LiveRoomDoc,
    tx: GiftTransactionDoc,
    gift: GiftDoc,
    names: Map<string, { displayName: string }>,
  ) {
    const receivers = tx.receivers.map((r) => ({
      id: r.userId,
      displayName: names.get(r.userId)?.displayName ?? 'User',
    }));
    const detail: LiveGiftMessage = {
      transactionId: String(tx._id),
      giftId: String(gift._id),
      name: gift.name,
      iconUrl: gift.iconUrl,
      quantity: tx.quantity,
      totalCost: tx.totalCost,
      receivers,
    };
    const text = `sent ${gift.name} ×${tx.quantity} to ${receivers.map((r) => r.displayName).join(', ')}`;
    const doc: LiveMessageDoc = {
      _id: tx._id,
      roomId: room._id,
      userId: tx.senderId,
      type: 'gift',
      text,
      voice: null,
      gift: detail,
      replyTo: null,
      createdAt: tx.createdAt,
      deletedAt: null,
    };
    try {
      await this.ctx.col.liveMessages.insertOne(doc);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    const { metadata } = await this.metadataFor(tx.senderId, this.roleOf(room, tx.senderId));
    return {
      id: String(doc._id),
      type: doc.type,
      text,
      voice: null,
      replyTo: null,
      gift: detail,
      user: metadata,
      at: doc.createdAt.toISOString(),
    };
  }

  /**
   * The first of [uids] who is not in [room]: not the host, not seated and not watching
   * (no `room_presence` row). Null when everyone is there.
   */
  async firstAbsent(room: LiveRoomDoc, uids: string[]): Promise<string | null> {
    const staged = new Set([room.hostId, ...room.seats.map((s) => s.userId)]);
    const rest = uids.filter((uid) => !staged.has(uid));
    if (!rest.length) return null;
    const present = await this.ctx.col.roomPresence
      .find({ roomId: room._id, identity: { $in: rest } }, { projection: { identity: 1 } })
      .toArray();
    const here = new Set(present.map((p) => p.identity));
    return rest.find((uid) => !here.has(uid)) ?? null;
  }

  /**
   * The author, the host, a room moderator, a platform moderator or staff can remove a chat
   * message for everyone. Messages of staff and platform moderators only by their author or
   * staff.
   */
  async deleteChat(
    roomId: ObjectId,
    actor: LiveActor,
    messageId: ObjectId,
  ): Promise<{ staffAction: boolean }> {
    const room = await this.getLive(roomId);
    const msg = await this.ctx.col.liveMessages.findOne({ _id: messageId, roomId });
    if (!msg) throw notFound('Message');
    const own = msg.userId === actor.uid;
    if (!own) {
      await this.assertCanModerate(room, actor.uid, actor.isAdmin);
      await this.assertNotProtected(msg.userId, actor);
    }
    const res = await this.ctx.col.liveMessages.updateOne(
      { _id: messageId, deletedAt: null },
      { $set: { deletedAt: this.ctx.clock.now() } },
    );
    if (res.modifiedCount)
      await this.broadcastSystem(room, { kind: 'chat_deleted', id: String(messageId) });
    return { staffAction: !own && this.outsider(room, actor) };
  }

  /** Heart reactions. Rate-limited per user at the route; clients coalesce the animation. */
  async react(roomId: ObjectId, uid: string, count: number): Promise<void> {
    const room = await this.getLive(roomId);
    await this.assertNotBanned(room, uid);
    await this.ctx.col.liveRooms.updateOne({ _id: room._id }, { $inc: { reactions: count } });
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
      .sendData(detail.livekitRoom, LIVEKIT_TOPICS.seats, {
        kind: 'seats',
        seats: detail.seats,
        swappedUid: detail.swappedUid,
      })
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
            'seats.$.absentSince': null,
            'seats.$.seatedAt': this.ctx.clock.now(),
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
      {
        $set: {
          'seats.$.userId': null,
          'seats.$.muted': false,
          'seats.$.videoMuted': false,
          'seats.$.absentSince': null,
          'seats.$.seatedAt': null,
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) return false;
    // A guest who leaves the stage gives the host their spot back.
    if (updated.swappedUid === uid)
      await this.ctx.col.liveRooms.updateOne(
        { _id: room._id, swappedUid: uid },
        { $set: { swappedUid: null } },
      );
    await this.syncParticipant(updated, uid, this.roleOf(updated, uid));
    await this.broadcastSeats(room._id);
    return true;
  }

  /**
   * Show a seated guest in the host's stage spot (and the host in theirs), or restore the
   * normal layout with `targetUid` null. Host, room admins and staff only. Server state, so
   * everyone in the room (late joiners too) sees the same layout.
   */
  async swapStage(
    roomId: ObjectId,
    actor: LiveActor,
    targetUid: string | null,
  ): Promise<{ swappedUid: string | null; staffAction: boolean }> {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    const staffAction = this.outsider(room, actor);
    if ((room.swappedUid ?? null) === targetUid)
      return { swappedUid: targetUid, staffAction: false };
    if (targetUid === null) {
      await this.ctx.col.liveRooms.updateOne(
        { _id: roomId, status: 'live' },
        { $set: { swappedUid: null } },
      );
    } else {
      const res = await this.ctx.col.liveRooms.updateOne(
        {
          _id: roomId,
          status: 'live',
          seats: { $elemMatch: { userId: targetUid, index: { $gt: 0 } } },
        },
        { $set: { swappedUid: targetUid } },
      );
      if (!res.matchedCount)
        throw new AppError(409, 'not_on_stage', 'Only a guest on a seat can take the host spot');
    }
    await this.broadcastSeats(roomId);
    return { swappedUid: targetUid, staffAction };
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
    actor: LiveActor,
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
      return { seated: false as const, staffAction: this.outsider(room, actor) };
    }
    try {
      const seated = await this.occupySeat(room, uid, index);
      await this.notifySeatStaff(room, { kind: 'request_resolved', uid, accepted: true }, [uid]);
      return { seated: true as const, index: seated, staffAction: this.outsider(room, actor) };
    } catch (err) {
      // No free seat: put the request back so it can be accepted once one frees up.
      await this.ctx.col.seatRequests
        .updateOne({ _id: req._id, status: 'accepted' }, { $set: { status: 'pending' } })
        .catch(() => undefined);
      throw err;
    }
  }

  async inviteToSeat(
    roomId: ObjectId,
    actor: LiveActor,
    uid: string,
  ): Promise<{ staffAction: boolean }> {
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
    return { staffAction: this.outsider(room, actor) };
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

  /**
   * A platform moderator takes a free seat without the host's approval, or leaves it
   * (`selfStageEnabled`). On a seat they are visible like any guest and a room admin; leaving,
   * they go back to hidden when stealth is on, and stop being an admin (the admin list would
   * give them away).
   */
  async platformModeratorStage(
    roomId: ObjectId,
    uid: string,
    onStage: boolean,
  ): Promise<{ onStage: boolean; index: number | null; hidden: boolean }> {
    const room = await this.getLive(roomId);
    const [user, cfg] = await Promise.all([
      this.ctx.services.users.get(uid),
      this.ctx.services.config.get('platformModerators'),
    ]);
    if (!isPlatformModerator(user)) throw forbidden('Platform moderators only');
    if (!cfg.selfStageEnabled) throw forbidden('Taking a seat without approval is turned off');
    if (room.hostId === uid) throw badRequest('You are the host');
    const seat = room.seats.find((s) => s.index > 0 && s.userId === uid);
    if (onStage) {
      if (seat) return { onStage: true, index: seat.index, hidden: false };
      const index = await this.occupySeat(room, uid, null);
      await this.ctx.col.seatRequests.updateMany(
        { roomId, userId: uid, status: 'pending' },
        { $set: { status: 'cancelled' } },
      );
      await this.addAutoAdmin(room, uid);
      return { onStage: true, index, hidden: false };
    }
    const hiddenNow = async () =>
      Boolean(
        (
          await this.ctx.col.roomPresence.findOne(
            { roomId, identity: uid },
            { projection: { hidden: 1 } },
          )
        )?.hidden,
      );
    if (!seat) return { onStage: false, index: null, hidden: await hiddenNow() };
    // Back to hidden if stealth is on now, even if they first joined visibly, and off the
    // admin list (quietly) before the seat re-mint, so they come back as hidden audience.
    if (cfg.stealthEnabled) {
      await this.ctx.col.roomPresence.updateOne(
        { roomId, identity: uid },
        { $set: { hidden: true } },
      );
      await this.pullAdminQuietly(roomId, uid);
    }
    await this.vacateSeatOf(room, uid);
    await this.syncViewerCount(roomId);
    return { onStage: false, index: null, hidden: await hiddenNow() };
  }

  /**
   * Take a platform moderator out of every room they watch hidden (their role was revoked).
   * They can rejoin, visibly.
   */
  async dropHidden(uid: string): Promise<number> {
    const rows = await this.ctx.col.roomPresence.find({ identity: uid, hidden: true }).toArray();
    for (const row of rows) {
      const room = await this.ctx.col.liveRooms.findOne(
        { _id: row.roomId },
        { projection: { livekitRoom: 1, status: 1 } },
      );
      await this.ctx.col.roomPresence.deleteOne({ _id: row._id });
      if (room?.status === 'live')
        await this.ctx.livekit.removeParticipant(room.livekitRoom, uid).catch(() => undefined);
    }
    return rows.length;
  }

  /** A platform moderator (or staff) ends someone's live from the app. */
  async endByModerator(roomId: ObjectId, actorUid: string): Promise<LiveRoomDoc> {
    const room = await this.getLive(roomId);
    if (room.hostId === actorUid) throw badRequest('End your own live from the live screen');
    const ended = await this.end(roomId, 'moderator', actorUid);
    if (!ended) throw new AppError(410, 'room_ended', 'This live has ended');
    return ended;
  }

  async manageSeat(
    roomId: ObjectId,
    actor: LiveActor,
    index: number,
    action: SeatAction,
  ): Promise<{ staffAction: boolean }> {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    // Someone acting in a room they don't run: the route audits it.
    const staffAction = this.outsider(room, actor);
    if (index === 0) throw badRequest('The host seat cannot be changed');
    const seat = room.seats.find((s) => s.index === index);
    if (!seat) throw notFound('Seat');
    if (
      seat.userId &&
      room.moderatorIds.includes(actor.uid) &&
      room.moderatorIds.includes(seat.userId)
    )
      throw forbidden('Moderators cannot manage other moderators');
    // Lifting a mute is harmless; anything that takes something away is not.
    if (seat.userId && action !== 'unmute' && action !== 'camera_on' && action !== 'unlock')
      await this.assertNotProtected(seat.userId, actor);
    switch (action) {
      case 'remove':
        if (seat.userId) await this.vacateSeatOf(room, seat.userId);
        return { staffAction };
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
    return { staffAction };
  }

  // ── LiveKit webhooks & sweeping ────────────────────────────────────────────────

  /**
   * `hidden` is the participant's LiveKit `permission.hidden` (a platform moderator in
   * stealth). It is kept on the presence row, so counts and lists leave them out even after a
   * redeploy, and their join is neither counted nor announced.
   */
  async onParticipantJoined(livekitRoom: string, identity: string, hidden = false): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom, status: 'live' },
      { projection: { _id: 1, hostId: 1 } },
    );
    if (!room || identity === room.hostId) return;
    const res = await this.ctx.col.roomPresence.updateOne(
      { roomId: room._id, identity },
      {
        $set: { hidden },
        $setOnInsert: { roomId: room._id, identity, joinedAt: this.ctx.clock.now() },
      },
      { upsert: true },
    );
    if (res.upsertedCount && !hidden) await this.countJoin(room._id, identity);
    // Only a first delivery announces the join; redelivered webhooks just recount.
    await this.syncViewerCount(room._id, res.upsertedCount && !hidden ? identity : undefined);
  }

  /**
   * Audience counters for the post-live summary. Runs once per presence row, so a redelivered
   * webhook never counts twice; `live_viewers` dedupes the unique count across reconnects.
   */
  private async countJoin(roomId: ObjectId, uid: string): Promise<void> {
    const seen = await this.ctx.col.liveViewers.updateOne(
      { _id: `${String(roomId)}:${uid}` },
      { $setOnInsert: { roomId, uid, createdAt: this.ctx.clock.now() } },
      { upsert: true },
    );
    await this.ctx.col.liveRooms.updateOne(
      { _id: roomId },
      { $inc: { totalJoins: 1, uniqueViewers: seen.upsertedCount ? 1 : 0 } },
    );
  }

  async onParticipantLeft(livekitRoom: string, identity: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom },
      { projection: { _id: 1, hostId: 1, status: 1, seats: 1, livekitRoom: 1 } },
    );
    if (!room) return;
    await this.ctx.col.roomPresence.deleteOne({ roomId: room._id, identity });
    if (room.status === 'live') {
      const seated = room.seats.some((x) => x.index > 0 && x.userId === identity);
      // A late `participant_left` for an old session must not unseat a guest who already
      // rejoined. If LiveKit can't tell us, free the seat (the guest can take one again).
      if (seated && !(await this.stillConnected(room.livekitRoom, identity)))
        await this.vacateSeatOf(room as LiveRoomDoc, identity).catch(() => false);
      await this.syncViewerCount(room._id);
    }
  }

  private async stillConnected(livekitRoom: string, identity: string): Promise<boolean> {
    try {
      return (await this.ctx.livekit.listParticipants(livekitRoom)).includes(identity);
    } catch {
      return false;
    }
  }

  /**
   * Free seats whose guest has left LiveKit without a `participant_left` we acted on (a lost
   * or late webhook, a killed app). Two strikes: the first sweep that misses a guest marks the
   * seat, a later one frees it, so a guest who is reconnecting keeps their seat. A room
   * LiveKit can't list is skipped, never emptied.
   */
  async reconcileSeats(): Promise<number> {
    const now = this.ctx.clock.now();
    const rooms = await this.ctx.col.liveRooms
      .find(
        { status: 'live', seats: { $elemMatch: { index: { $gt: 0 }, userId: { $ne: null } } } },
        { projection: { _id: 1, hostId: 1, livekitRoom: 1, seats: 1, moderatorIds: 1 } },
      )
      .limit(500)
      .toArray();
    let freed = 0;
    for (const room of rooms) {
      let connected: Set<string>;
      try {
        connected = new Set(await this.ctx.livekit.listParticipants(room.livekitRoom));
      } catch (err) {
        this.ctx.log.warn({ err, room: room.livekitRoom }, 'seat reconcile: list failed');
        continue;
      }
      for (const seat of room.seats) {
        if (seat.index === 0 || !seat.userId) continue;
        const uid = seat.userId;
        if (connected.has(uid)) {
          if (seat.absentSince)
            await this.ctx.col.liveRooms.updateOne(
              { _id: room._id, seats: { $elemMatch: { index: seat.index, userId: uid } } },
              { $set: { 'seats.$.absentSince': null } },
            );
          continue;
        }
        if (!seat.absentSince) {
          await this.ctx.col.liveRooms.updateOne(
            { _id: room._id, seats: { $elemMatch: { index: seat.index, userId: uid } } },
            { $set: { 'seats.$.absentSince': now } },
          );
          continue;
        }
        if (now.getTime() - seat.absentSince.getTime() < SEAT_ABSENT_GRACE_MS) continue;
        try {
          if (await this.vacateSeatOf(room as LiveRoomDoc, uid)) freed++;
        } catch (err) {
          this.ctx.log.warn({ err, uid }, 'seat reconcile: vacate failed');
        }
      }
    }
    return freed;
  }

  /**
   * Viewer count is recomputed from presence rows, so webhook redelivery cannot skew it. The room
   * gets the new count and its top viewers, so clients don't poll for them.
   */
  private async syncViewerCount(roomId: ObjectId, joinedUid?: string): Promise<void> {
    const count = await this.ctx.col.roomPresence.countDocuments({
      roomId,
      hidden: { $ne: true },
    });
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

  // ── Automated moderation (SightGuard verdicts; no human actor) ──────────────────

  /** Live room for a LiveKit room name, if it is one of ours and still live. */
  async liveByLivekitRoom(livekitRoom: string): Promise<LiveRoomDoc | null> {
    return this.ctx.col.liveRooms.findOne({ livekitRoom, status: 'live' });
  }

  /** Ends a live on a SightGuard verdict. */
  async systemEnd(room: LiveRoomDoc, reason: string): Promise<boolean> {
    const ended = await this.end(room._id, 'moderation', 'system');
    if (!ended) return false;
    await this.ctx.services.audit.recordSystem(
      'sightguard.live.end',
      { type: 'room', id: String(room._id) },
      { hostId: room.hostId, reason },
    );
    return true;
  }

  /**
   * Removes a participant on a SightGuard verdict, with a short room ban so they can't rejoin
   * straight away. The host is never evicted from their own live: end it instead.
   */
  async systemRemove(room: LiveRoomDoc, uid: string, reason: string): Promise<boolean> {
    if (uid === room.hostId) return false;
    await this.evict(room, uid, 'system', SYSTEM_REMOVE_BAN_MINUTES);
    await this.ctx.services.audit.recordSystem(
      'sightguard.live.remove',
      { type: 'user', id: uid },
      { roomId: String(room._id), reason, banMinutes: SYSTEM_REMOVE_BAN_MINUTES },
    );
    return true;
  }

  /**
   * Turns off one kind of media on the SFU after a violation (video for visual and on-screen
   * text, audio for speech). A seated guest's seat flag is set too, so their client keeps it
   * off and only a host or room admin can lift it. The host seat carries no flag (nobody could
   * clear it); a host who turns the camera back on and offends again is escalated by
   * SightGuard's strike ladder.
   */
  async systemMute(
    room: LiveRoomDoc,
    uid: string,
    kind: 'audio' | 'video',
    reason: string,
  ): Promise<void> {
    await this.ctx.livekit
      .muteTracks(room.livekitRoom, uid, kind, true)
      .catch((err: unknown) => this.ctx.log.warn({ err }, 'moderation mute failed'));
    const seat = room.seats.find((x) => x.userId === uid && x.index > 0);
    if (seat) {
      await this.ctx.col.liveRooms.updateOne(
        { _id: room._id, 'seats.index': seat.index, 'seats.userId': uid },
        { $set: { [kind === 'audio' ? 'seats.$.muted' : 'seats.$.videoMuted']: true } },
      );
      await this.broadcastSeats(room._id);
    }
    await this.notifyModeration(room, uid, { action: 'muted', media: kind });
    await this.ctx.services.audit.recordSystem(
      'sightguard.live.mute',
      { type: 'user', id: uid },
      { roomId: String(room._id), media: kind, reason },
    );
  }

  /** Private in-room notice to one participant (`bb.system`, kind `moderation`). */
  async notifyModeration(
    room: LiveRoomDoc,
    uid: string,
    payload: { action: 'warn' | 'muted'; media?: 'audio' | 'video' },
  ): Promise<void> {
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.system, { kind: 'moderation', ...payload }, [uid])
      .catch(() => undefined);
  }

  /** Removes a chat message a moderator rejected after it went out. */
  async systemDeleteChat(roomId: ObjectId, messageId: ObjectId): Promise<boolean> {
    const res = await this.ctx.col.liveMessages.updateOne(
      { _id: messageId, roomId, deletedAt: null },
      { $set: { deletedAt: this.ctx.clock.now() } },
    );
    if (!res.modifiedCount) return false;
    const room = await this.ctx.col.liveRooms.findOne({ _id: roomId, status: 'live' });
    if (room) await this.broadcastSystem(room, { kind: 'chat_deleted', id: String(messageId) });
    return true;
  }

  /**
   * Undoes a rejected title or cover while the room is still live. Conditional on the value,
   * so a newer title or picture set since then is left alone.
   */
  async systemResetRoomField(
    roomId: ObjectId,
    field: 'title' | 'coverUrl' | 'backgroundUrl',
    rejected?: string,
  ): Promise<boolean> {
    const room = await this.ctx.col.liveRooms.findOne({ _id: roomId, status: 'live' });
    if (!room) return false;
    const value =
      field === 'title'
        ? (await this.ctx.services.users.get(room.hostId)).displayName.slice(0, 60)
        : null;
    const res = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live', ...(rejected !== undefined ? { [field]: rejected } : {}) },
      { $set: { [field]: value } },
      { returnDocument: 'after' },
    );
    if (!res) return false;
    await this.broadcastSystem(res, {
      kind: 'room_updated',
      title: res.title,
      coverUrl: res.coverUrl,
      backgroundUrl: effectiveBackground(res),
    });
    await this.publishDirectory(roomId);
    return true;
  }

  /** Live covers and backgrounds are shown to everyone: fail closed. Platform assets pass. */
  private async assertCover(
    roomId: ObjectId,
    hostId: string,
    field: 'coverUrl' | 'backgroundUrl',
    url: string,
  ): Promise<void> {
    if (await this.ctx.storage.isPlatformAsset(url)) return;
    await this.ctx.services.sightguard.assertImageUrl('live_cover', url, hostId, {
      type: 'live_cover',
      roomId: String(roomId),
      field,
      url,
    });
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
    await this.reconcileSeats().catch((err: unknown) =>
      this.ctx.log.error({ err }, 'seat reconcile failed'),
    );
    // Expire seat requests/invites past their TTL.
    await this.ctx.col.seatRequests.updateMany(
      { status: 'pending', expiresAt: { $lte: this.ctx.clock.now() } },
      { $set: { status: 'expired' } },
    );
    return ended;
  }
}

/** Minutes a participant removed by automated moderation stays banned from that host's room. */
const SYSTEM_REMOVE_BAN_MINUTES = 30;

const supervised = (room: LiveRoomDoc) => ({
  roomId: String(room._id),
  livekitRoom: room.livekitRoom,
  hostId: room.hostId,
});

/** What a reply shows of the message it answers. */
function replyPreview(m: LiveMessageDoc): string {
  if (m.type === 'voice') return '🎤 Voice message';
  if (m.type === 'gift' && m.gift) return `🎁 ${m.gift.name} ×${m.gift.quantity}`;
  return m.text.slice(0, 80);
}
