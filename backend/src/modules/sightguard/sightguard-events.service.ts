import { ObjectId } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc } from '../../db/schema.js';
import type {
  LiveViolationData,
  ReviewCompletedData,
  VideoJob,
  WebhookEvent,
} from '../../infra/sightguard.js';
import { isDuplicateKeyError } from '../../lib/errors.js';
import { refFromMetadata, type ContentRef } from './sightguard.service.js';

const GUIDELINES = 'Violates community guidelines';

/**
 * Turns SightGuard verdicts into BigBoss actions through BigBoss's own services, so room
 * state, audit logs and realtime events stay consistent (SightGuard never touches this DB).
 *
 *   live.violation   warn → notice · mute_track → camera/mic off · remove_participant → evict
 *                    (the host: end the live) · end_room → end the live (optional ban)
 *   video.completed  reject → remove the post carrying the video
 *   review.completed reject → undo what was published while it waited for review
 *
 * Deliveries are at-least-once. The `sightguard_events` insert is the dedupe guard; when
 * handling fails the row is dropped again so SightGuard's retry is processed. Every action is
 * idempotent on its own as well (conditional updates), so a partial failure is safe to replay.
 */
export class SightGuardEventsService {
  constructor(private readonly ctx: Ctx) {}

  /** Returns false for a duplicate delivery. */
  async handle(event: WebhookEvent): Promise<boolean> {
    try {
      await this.ctx.col.sightguardEvents.insertOne({
        _id: event.id,
        type: event.type,
        receivedAt: this.ctx.clock.now(),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
    try {
      switch (event.type) {
        case 'live.violation':
          await this.onViolation(event.data);
          break;
        case 'video.completed':
          await this.onVideo(event.data);
          break;
        case 'review.completed':
          await this.onReview(event.data);
          break;
        default:
          break; // live.session.ended, ping: nothing to do
      }
    } catch (err) {
      await this.ctx.col.sightguardEvents.deleteOne({ _id: event.id }).catch(() => undefined);
      throw err;
    }
    return true;
  }

  private async onViolation(v: LiveViolationData): Promise<void> {
    const live = this.ctx.services.live;
    let room = await live.liveByLivekitRoom(v.room);
    if (!room) return; // already ended, or not one of ours
    const uid = v.participantIdentity;
    // In a PK battle the opponent's tracks are SFU-forwarded into this room under their own
    // identity: act on the opponent's own live, as its host.
    if (uid !== room.hostId && room.pkBattleId) {
      const own = await this.ctx.col.liveRooms.findOne({ hostId: uid, status: 'live' });
      if (own?.pkBattleId?.equals(room.pkBattleId)) room = own;
    }
    const isHost = uid === room.hostId;
    const categories = v.reasons.map((r) => r.category);
    const why = `Automated moderation: ${categories.join(', ') || 'policy violation'}`;
    this.ctx.log.warn(
      { roomId: String(room._id), uid, action: v.action, strikes: v.strikes, source: v.source },
      'sightguard live violation',
    );

    switch (v.action) {
      case 'warn':
        await live.notifyModeration(room, uid, { action: 'warn' });
        await this.ctx.services.notifications.notify(
          uid,
          {
            type: 'system',
            title: 'Community guidelines warning',
            body: 'Your live content may break our community guidelines. Continued violations will end your live.',
            data: { roomId: String(room._id) },
          },
          { push: false },
        );
        break;
      case 'mute_track':
        await live.systemMute(room, uid, v.source === 'audio' ? 'audio' : 'video', why);
        break;
      case 'remove_participant':
        if (isHost) await live.systemEnd(room, why);
        else await live.systemRemove(room, uid, why);
        break;
      case 'end_room':
        await live.systemEnd(room, why);
        if (v.recommendBan) await this.autoBan(uid, why, room);
        break;
    }
  }

  private async onVideo(job: VideoJob & { metadata?: Record<string, unknown> }): Promise<void> {
    if (job.status !== 'completed' || job.decision !== 'reject') return;
    await this.undo(refFromMetadata(job.metadata), `${GUIDELINES} (video)`);
  }

  private async onReview(r: ReviewCompletedData): Promise<void> {
    if (r.decision !== 'reject') return;
    if (r.kind === 'live') {
      // A moderator confirmed a live violation; the participant is the userRef.
      if (r.userRef)
        await this.autoBan(r.userRef, `${GUIDELINES} (live, confirmed by ${r.reviewer})`);
      return;
    }
    await this.undo(refFromMetadata(r.metadata), r.note ?? GUIDELINES);
  }

  /** Only with SIGHTGUARD_AUTO_BAN: an automated signal alone should not permanently ban. */
  private async autoBan(uid: string, reason: string, room?: LiveRoomDoc): Promise<void> {
    if (!this.ctx.env.SIGHTGUARD_AUTO_BAN) return;
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { status: 1, adminRole: 1 } },
    );
    // Unknown identities and staff accounts are never auto-banned; staff go to a human.
    if (!user || user.status !== 'active' || user.adminRole) return;
    await this.ctx.services.users.ban(uid, { reason, until: null, by: 'system' });
    await this.ctx.services.audit.recordSystem(
      'sightguard.user.ban',
      { type: 'user', id: uid },
      { reason, ...(room ? { roomId: String(room._id) } : {}) },
    );
  }

  /** Reverses publication of content rejected after it went out. */
  private async undo(ref: ContentRef | null, reason: string): Promise<void> {
    if (!ref) return;
    const s = this.ctx.services;
    let owner: string | null = null;
    let notice: string | null = null;
    switch (ref.type) {
      case 'post':
        if (!ObjectId.isValid(ref.postId)) return;
        owner = await s.feed.systemRemovePost(new ObjectId(ref.postId));
        notice = 'Your post was removed for breaking our community guidelines.';
        break;
      case 'comment':
        if (!ObjectId.isValid(ref.commentId)) return;
        owner = await s.feed.systemRemoveComment(new ObjectId(ref.commentId));
        notice = 'Your comment was removed for breaking our community guidelines.';
        break;
      case 'message':
        if (!ObjectId.isValid(ref.messageId)) return;
        owner = await s.chat.systemRemove(new ObjectId(ref.messageId));
        break;
      case 'live_message':
        if (!ObjectId.isValid(ref.roomId) || !ObjectId.isValid(ref.messageId)) return;
        await s.live.systemDeleteChat(new ObjectId(ref.roomId), new ObjectId(ref.messageId));
        break;
      case 'live_title':
        if (!ObjectId.isValid(ref.roomId)) return;
        await s.live.systemResetRoomField(new ObjectId(ref.roomId), 'title');
        break;
      case 'live_cover':
        if (!ObjectId.isValid(ref.roomId)) return;
        await s.live.systemResetRoomField(new ObjectId(ref.roomId), ref.field, ref.url);
        break;
      case 'avatar': {
        // Only if it is still their avatar: they may have changed it since.
        const res = await this.ctx.col.users.updateOne(
          { _id: ref.uid, avatarUrl: ref.url },
          { $set: { avatarUrl: null, updatedAt: this.ctx.clock.now() } },
        );
        if (res.modifiedCount) {
          owner = ref.uid;
          notice = 'Your profile picture was removed for breaking our community guidelines.';
        }
        break;
      }
      case 'profile': {
        const user = await this.ctx.col.users.findOne(
          { _id: ref.uid },
          { projection: { shortId: 1 } },
        );
        if (!user) return;
        const $set =
          ref.field === 'bio'
            ? { bio: '' }
            : { displayName: `Boss${user.shortId}`, displayNameLower: `boss${user.shortId}` };
        await this.ctx.col.users.updateOne(
          { _id: ref.uid },
          { $set: { ...$set, updatedAt: this.ctx.clock.now() } },
        );
        owner = ref.uid;
        notice =
          ref.field === 'bio'
            ? 'Your bio was cleared for breaking our community guidelines.'
            : 'Your display name was reset for breaking our community guidelines.';
        break;
      }
    }
    await s.audit.recordSystem(
      'sightguard.content.removed',
      { type: ref.type, id: refId(ref) },
      { ref, reason },
    );
    if (owner && notice)
      await s.notifications
        .notify(owner, { type: 'system', title: 'Content removed', body: notice })
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'moderation notice failed'));
  }
}

function refId(ref: ContentRef): string {
  switch (ref.type) {
    case 'post':
      return ref.postId;
    case 'comment':
      return ref.commentId;
    case 'message':
    case 'live_message':
      return ref.messageId;
    case 'live_title':
    case 'live_cover':
      return ref.roomId;
    case 'avatar':
    case 'profile':
      return ref.uid;
  }
}
