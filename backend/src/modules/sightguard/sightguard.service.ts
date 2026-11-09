import { z } from 'zod';
import type { Ctx } from '../../context.js';
import {
  ModerationUnavailableError,
  type ModerationMetadata,
  type ModerationVerdict,
} from '../../infra/sightguard.js';
import { contentRejected, moderationUnavailable } from '../../lib/errors.js';

/** SightGuard channels: each selects a policy (thresholds, fail mode) in its dashboard. */
export type TextChannel =
  'live_chat' | 'live_title' | 'private_chat' | 'comment' | 'post_text' | 'username' | 'bio';
export type ImageChannel = 'avatar' | 'post_image' | 'chat_media' | 'live_cover';

/** Shown to everyone, so they are refused when they cannot be checked. */
const FAIL_CLOSED: ReadonlySet<ImageChannel> = new Set(['avatar', 'live_cover']);

/**
 * What a later `review.completed` (or `video.completed`) reject must undo. Sent to SightGuard
 * as flat metadata and echoed back on webhooks, so ids are allocated before the check.
 */
const contentRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post'), postId: z.string() }),
  z.object({ type: z.literal('comment'), commentId: z.string() }),
  z.object({ type: z.literal('message'), messageId: z.string() }),
  z.object({ type: z.literal('live_message'), roomId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal('live_title'), roomId: z.string() }),
  z.object({
    type: z.literal('live_cover'),
    roomId: z.string(),
    field: z.enum(['coverUrl', 'backgroundUrl']),
    url: z.string(),
  }),
  z.object({ type: z.literal('avatar'), uid: z.string(), url: z.string() }),
  z.object({ type: z.literal('profile'), uid: z.string(), field: z.enum(['displayName', 'bio']) }),
]);
export type ContentRef = z.infer<typeof contentRefSchema>;

const metadataOf = (ref?: ContentRef): ModerationMetadata | undefined =>
  ref ? Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, String(v)])) : undefined;

/** Parses the metadata echoed on a webhook. Unknown or foreign shapes yield null. */
export function refFromMetadata(m: unknown): ContentRef | null {
  const parsed = contentRefSchema.safeParse(m);
  return parsed.success ? parsed.data : null;
}

/**
 * BigBoss's rules on top of SightGuard verdicts:
 *  - text and most images fail OPEN (an outage must not take chat or posting down),
 *  - avatars and live covers fail CLOSED (refused when they cannot be checked),
 *  - `review` publishes now; a moderator's later verdict arrives as a webhook and is undone
 *    by `SightGuardEventsService` through the content ref.
 * When SightGuard is not configured every check allows without a call.
 */
export class SightGuardService {
  constructor(private readonly ctx: Ctx) {}

  get enabled(): boolean {
    return this.ctx.sightguard.enabled;
  }

  /** Throws `content_rejected` when the text is rejected; allows when SightGuard is down. */
  async assertText(
    channel: TextChannel,
    text: string,
    uid: string,
    ref?: ContentRef,
  ): Promise<void> {
    if (!this.enabled || !text.trim()) return;
    const v = await this.failOpen(channel, () =>
      this.ctx.sightguard.moderateText(text, { channel, userRef: uid, metadata: metadataOf(ref) }),
    );
    if (v?.decision === 'reject') throw contentRejected(v.categories);
  }

  /** Live chat: a tight time budget keeps chat instant. On timeout the message goes out. */
  async assertChat(text: string, uid: string, ref: ContentRef): Promise<void> {
    if (!this.enabled || !text.trim()) return;
    const v = await this.failOpen('live_chat', () =>
      this.ctx.sightguard.moderateText(text, {
        channel: 'live_chat',
        userRef: uid,
        metadata: metadataOf(ref),
        timeoutMs: this.ctx.env.SIGHTGUARD_CHAT_TIMEOUT_MS,
      }),
    );
    if (v?.decision === 'reject')
      throw contentRejected(v.categories, 'Message not sent: it breaks the community guidelines');
  }

  /** SightGuard fetches the image from its public URL (uploads never pass through the API). */
  async assertImageUrl(
    channel: ImageChannel,
    url: string,
    uid: string,
    ref?: ContentRef,
  ): Promise<void> {
    if (!this.enabled) return;
    const check = () =>
      this.ctx.sightguard.moderateImageUrl(url, {
        channel,
        userRef: uid,
        metadata: metadataOf(ref),
      });
    let v: ModerationVerdict | null;
    if (FAIL_CLOSED.has(channel)) {
      try {
        v = await check();
      } catch (err) {
        if (!(err instanceof ModerationUnavailableError)) throw err;
        if (err.invalidMedia) throw contentRejected([], 'This file is not a valid image');
        this.ctx.log.warn({ err, channel }, 'sightguard image check failed closed');
        throw moderationUnavailable();
      }
    } else {
      v = await this.failOpen(channel, check);
    }
    if (v?.decision === 'reject') throw contentRejected(v.categories);
  }

  /** Async video check; a reject arrives as `video.completed` and undoes `ref`. */
  async submitVideo(url: string, uid: string, ref: ContentRef): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue('sightguard.video', { url, userId: uid, metadata: metadataOf(ref)! });
  }

  /** Starts live supervision. Queued with retries, so it never blocks or fails going live. */
  async startLive(room: { roomId: string; livekitRoom: string; hostId: string }): Promise<void> {
    if (!this.ctx.sightguard.liveEnabled) return;
    await this.enqueue('sightguard.live', { op: 'start', ...room });
  }

  async endLive(room: { roomId: string; livekitRoom: string; hostId: string }): Promise<void> {
    if (!this.ctx.sightguard.liveEnabled) return;
    await this.enqueue('sightguard.live', { op: 'end', ...room });
  }

  /** Job handler for `sightguard.live`. Throws on outages so the queue retries. */
  async runLiveJob(job: {
    op: 'start' | 'end';
    roomId: string;
    livekitRoom: string;
    hostId: string;
  }): Promise<void> {
    if (job.op === 'start') {
      // A retry after the live ended must not put an ended room back under supervision.
      const live = await this.ctx.col.liveRooms.countDocuments(
        { livekitRoom: job.livekitRoom, status: 'live' },
        { limit: 1 },
      );
      if (!live) return;
      await this.retryable('live start', () =>
        this.ctx.sightguard.startLive({
          room: job.livekitRoom,
          hostIdentity: job.hostId,
          metadata: { roomId: job.roomId },
        }),
      );
    } else {
      await this.retryable('live end', () => this.ctx.sightguard.endLive(job.livekitRoom));
    }
  }

  /** Job handler for `sightguard.video`. */
  async runVideoJob(job: {
    url: string;
    userId: string;
    metadata: Record<string, string>;
  }): Promise<void> {
    await this.retryable('video submit', () =>
      this.ctx.sightguard.submitVideo(job.url, {
        channel: 'post_video',
        userRef: job.userId,
        metadata: job.metadata,
      }),
    );
  }

  private async failOpen(
    channel: string,
    fn: () => Promise<ModerationVerdict>,
  ): Promise<ModerationVerdict | null> {
    try {
      return await fn();
    } catch (err) {
      this.ctx.log.warn({ err, channel }, 'sightguard check failed open');
      return null;
    }
  }

  /** Outages rethrow (the job queue retries); a refused request is logged and dropped. */
  private async retryable(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ModerationUnavailableError && !err.invalidMedia) throw err;
      this.ctx.log.warn({ err }, `sightguard ${what} refused`);
    }
  }

  private async enqueue<K extends 'sightguard.live' | 'sightguard.video'>(
    name: K,
    data: K extends 'sightguard.live'
      ? { op: 'start' | 'end'; roomId: string; livekitRoom: string; hostId: string }
      : { url: string; userId: string; metadata: Record<string, string> },
  ): Promise<void> {
    // Moderation bookkeeping never fails the user action that triggered it.
    await this.ctx.jobs
      .enqueue(name, data as never)
      .catch((err: unknown) => this.ctx.log.error({ err, job: name }, 'sightguard enqueue failed'));
  }
}
