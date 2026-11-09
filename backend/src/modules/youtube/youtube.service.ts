import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  LIVEKIT_TOPICS,
  YT_QUEUE_MAX,
  type YtAddedBy,
  type YtItem,
  type YtSearchResult,
} from '@bigboss/shared';
import type { ObjectId } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc, YouTubeStateDoc, YoutubeCacheDoc } from '../../db/schema.js';
import type { YtVideo } from '../../infra/youtube.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { REFUSAL_MESSAGES, ytRefusal, type YtRules } from './eligibility.js';
import { looksLikeVideoId, parseYouTubeUrl } from './url.js';
import {
  EMPTY_YOUTUBE,
  advance,
  atEnd,
  rebased,
  startPlaying,
  youtubeView,
} from './youtube.state.js';

/** `ended` is believed this close to the end, to absorb clock and buffering skew. */
const END_SLACK_MS = 3_000;
/** The sweeper waits this long past the end for a player to report it first. */
const SWEEP_GRACE_MS = 5_000;
/** A looked-up video is reused for this long (play, enqueue, a pasted link). */
const LOOKUP_CACHE_MS = 15 * 60_000;
const MAX_WRITE_ATTEMPTS = 4;

const newQid = () => randomBytes(6).toString('hex');
const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'Not a YouTube video id');
const qid = z.string().min(1).max(32);

export const youtubeSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  pageToken: z.string().max(200).optional(),
});

export const youtubeCommandInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play'), videoId }).strict(),
  z.object({ action: z.literal('enqueue'), videoId }).strict(),
  z.object({ action: z.literal('playQueued'), qid }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z
    .object({
      action: z.literal('seek'),
      positionMs: z
        .number()
        .int()
        .min(0)
        .max(24 * 3600_000),
    })
    .strict(),
  // Names the song it skips, so a double tap or a retry skips once.
  z.object({ action: z.literal('next'), fromQid: qid.nullable() }).strict(),
  z.object({ action: z.literal('remove'), qid }).strict(),
  z.object({ action: z.literal('move'), qid, toIndex: z.number().int().min(0).max(1000) }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('clearQueue') }).strict(),
]);
export type YouTubeCommand = z.infer<typeof youtubeCommandInput>;

export const youtubeEndedInput = z.object({ qid }).strict();

export interface YouTubeActor {
  uid: string;
  isAdmin: boolean;
}

type Rules = YtRules & { safeSearch: 'none' | 'moderate' | 'strict'; searchCacheSec: number };

/**
 * YouTube music in a live. Every viewer runs YouTube's official player and follows this
 * state, so nothing is extracted or mixed into a microphone. This service is the only writer
 * of `live_rooms.youtube`: each write is one update conditional on `youtube.rev`, then a full
 * snapshot on `bb.youtube`. The client only names a video id; the video is checked with
 * YouTube before it is accepted.
 */
export class YouTubeService {
  constructor(private readonly ctx: Ctx) {}

  private now(): number {
    return this.ctx.clock.now().getTime();
  }

  private rules(): Promise<Rules> {
    return this.ctx.services.config.get('youtube');
  }

  private async assertEnabled(): Promise<void> {
    const { youtubeEnabled } = await this.ctx.services.config.get('features');
    if (!youtubeEnabled)
      throw new AppError(403, 'feature_off', 'YouTube music is not available right now');
  }

  /** The host, the room's admins and platform staff run the music. */
  private async controlled(actor: YouTubeActor, roomId: ObjectId): Promise<LiveRoomDoc> {
    const room = await this.ctx.services.live.getLive(roomId);
    if (!actor.isAdmin && room.hostId !== actor.uid && !room.moderatorIds.includes(actor.uid))
      throw forbidden('Only the host and room admins can play music');
    return room;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(
    actor: YouTubeActor,
    roomId: ObjectId,
    q: string,
    pageToken?: string,
  ): Promise<{ items: YtSearchResult[]; nextPageToken: string | null }> {
    await this.assertEnabled();
    await this.controlled(actor, roomId);
    const rules = await this.rules();
    const query = q.trim();
    const linked = parseYouTubeUrl(query);
    if (linked)
      return {
        items: (await this.lookup([linked])).map((v) => this.result(v, rules)),
        nextPageToken: null,
      };
    if (looksLikeVideoId(query) && !pageToken) {
      const found = await this.lookup([query]);
      if (found.length > 0)
        return { items: found.map((v) => this.result(v, rules)), nextPageToken: null };
    }
    const page = await this.cachedSearch(query, pageToken, rules);
    return {
      items: page.videos.map((v) => this.result(v, rules)),
      nextPageToken: page.nextPageToken,
    };
  }

  private result(v: YtVideo, rules: YtRules): YtSearchResult {
    const reason = ytRefusal(v, rules);
    return {
      videoId: v.videoId,
      title: v.title,
      channel: v.channel,
      durationSec: v.durationSec,
      playable: reason === null,
      reason,
    };
  }

  /**
   * One search page, from the cache when someone searched the same thing recently: a search
   * costs 100 of the 10,000 daily quota units. The key holds no uid.
   */
  private async cachedSearch(
    q: string,
    pageToken: string | undefined,
    rules: Rules,
  ): Promise<Pick<YoutubeCacheDoc, 'videos' | 'nextPageToken'>> {
    const normalized = q.toLowerCase().replace(/\s+/g, ' ');
    const key = `s:${createHash('sha256')
      .update(`${normalized}|${rules.regionCode}|${rules.safeSearch}|${pageToken ?? ''}`)
      .digest('hex')}`;
    const now = new Date(this.now());
    const hit = await this.ctx.col.youtubeCache.findOne({ _id: key, expiresAt: { $gt: now } });
    if (hit) return hit;
    const page = await this.ctx.youtube.search(q, {
      safeSearch: rules.safeSearch,
      ...(rules.regionCode ? { regionCode: rules.regionCode } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const byId = new Map((await this.ctx.youtube.videos(page.ids)).map((v) => [v.videoId, v]));
    const videos = page.ids.map((id) => byId.get(id)).filter((v): v is YtVideo => v !== undefined);
    const doc = {
      videos,
      nextPageToken: page.nextPageToken,
      createdAt: now,
      expiresAt: new Date(now.getTime() + rules.searchCacheSec * 1000),
    };
    await this.ctx.col.youtubeCache.replaceOne({ _id: key }, doc, { upsert: true });
    return doc;
  }

  /** Video details, briefly cached per id. Unknown ids are left out. */
  private async lookup(ids: string[]): Promise<YtVideo[]> {
    const now = new Date(this.now());
    const cached = await this.ctx.col.youtubeCache
      .find({ _id: { $in: ids.map((id) => `v:${id}`) }, expiresAt: { $gt: now } })
      .toArray();
    const have = new Map(cached.flatMap((d) => d.videos).map((v) => [v.videoId, v]));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length > 0) {
      const fresh = await this.ctx.youtube.videos(missing);
      const expiresAt = new Date(now.getTime() + LOOKUP_CACHE_MS);
      await Promise.all(
        fresh.map((v) => {
          have.set(v.videoId, v);
          return this.ctx.col.youtubeCache.replaceOne(
            { _id: `v:${v.videoId}` },
            { videos: [v], nextPageToken: null, createdAt: now, expiresAt },
            { upsert: true },
          );
        }),
      );
    }
    return ids.map((id) => have.get(id)).filter((v): v is YtVideo => v !== undefined);
  }

  /** [id] as a queue entry, after YouTube and our rules accept it. */
  private async item(id: string, addedBy: YtAddedBy): Promise<YtItem> {
    const [video] = await this.lookup([id]);
    if (!video) throw notFound('Video');
    const reason = ytRefusal(video, await this.rules());
    if (reason) throw new AppError(400, `youtube_${reason}`, REFUSAL_MESSAGES[reason]);
    return {
      qid: newQid(),
      videoId: id,
      title: trim(video.title, 100),
      channel: trim(video.channel, 60),
      durationSec: video.durationSec,
      addedBy,
    };
  }

  private async addedBy(uid: string): Promise<YtAddedBy> {
    const brief = (await this.ctx.services.users.briefs([uid])).get(uid);
    return { uid, displayName: brief?.displayName ?? '' };
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  /**
   * Runs [cmd] for [actor]. `staffAction` is true when platform staff changed a room they
   * neither host nor moderate, so the route can audit it.
   */
  async command(actor: YouTubeActor, roomId: ObjectId, cmd: YouTubeCommand) {
    if (cmd.action === 'play' || cmd.action === 'enqueue') await this.assertEnabled();
    const room = await this.controlled(actor, roomId);
    const item =
      cmd.action === 'play' || cmd.action === 'enqueue'
        ? await this.item(cmd.videoId, await this.addedBy(actor.uid))
        : null;

    const result = await this.write(room._id, (s, now) => {
      const cur = s.current;
      switch (cmd.action) {
        case 'play':
          return { ...s, current: startPlaying(item!, now) };
        case 'enqueue':
          if (!cur) return { ...s, current: startPlaying(item!, now) };
          if (s.queue.some((q) => q.videoId === item!.videoId))
            throw conflict('This song is already in the queue', 'already_queued');
          if (s.queue.length >= YT_QUEUE_MAX)
            throw conflict(`The queue holds up to ${YT_QUEUE_MAX} songs`, 'queue_full');
          return { ...s, queue: [...s.queue, item!] };
        case 'playQueued': {
          const picked = s.queue.find((q) => q.qid === cmd.qid);
          if (!picked) return null;
          return {
            ...s,
            current: startPlaying(picked, now),
            queue: s.queue.filter((q) => q.qid !== cmd.qid),
          };
        }
        case 'pause':
          if (!cur) throw conflict('Nothing is playing', 'no_music');
          return cur.playing ? { ...s, current: rebased(cur, now, { playing: false }) } : null;
        case 'resume':
          if (!cur) throw conflict('Nothing is playing', 'no_music');
          return cur.playing ? null : { ...s, current: rebased(cur, now, { playing: true }) };
        case 'seek':
          if (!cur) throw conflict('Nothing is playing', 'no_music');
          return { ...s, current: rebased(cur, now, { positionMs: cmd.positionMs }) };
        case 'next':
          if ((cur?.qid ?? null) !== cmd.fromQid) return null;
          if (!cur && s.queue.length === 0) return null;
          return advance(s, now);
        case 'remove':
          if (cur?.qid === cmd.qid) return advance(s, now);
          if (!s.queue.some((q) => q.qid === cmd.qid)) return null;
          return { ...s, queue: s.queue.filter((q) => q.qid !== cmd.qid) };
        case 'move': {
          const from = s.queue.findIndex((q) => q.qid === cmd.qid);
          if (from < 0) return null;
          const to = Math.min(Math.max(0, cmd.toIndex), s.queue.length - 1);
          if (to === from) return null;
          const queue = [...s.queue];
          const [moved] = queue.splice(from, 1);
          queue.splice(to, 0, moved!);
          return { ...s, queue };
        }
        case 'stop':
          return cur ? { ...s, current: null } : null;
        case 'clearQueue':
          return s.queue.length > 0 ? { ...s, queue: [] } : null;
      }
    });

    const staffAction =
      result.changed && room.hostId !== actor.uid && !room.moderatorIds.includes(actor.uid);
    return { youtube: youtubeView(result.state), serverNow: result.now, staffAction };
  }

  /**
   * A player reports that [qid] finished. Anyone in the live may say so: it advances only
   * while [qid] is still playing and the server's own clock agrees it is at the end, so it
   * can't be used to skip songs.
   */
  async ended(roomId: ObjectId, qid: string) {
    const room = await this.ctx.services.live.getLive(roomId);
    const result = await this.write(room._id, (s, now) =>
      atEnd(s, qid, now, END_SLACK_MS) ? advance(s, now) : null,
    );
    return { youtube: youtubeView(result.state), serverNow: result.now, advanced: result.changed };
  }

  /** Advances lives whose song ended with nobody reporting it (every player hidden). */
  async sweep(): Promise<number> {
    const due = await this.ctx.col.liveRooms
      .find(
        { status: 'live', 'youtube.current.endsAt': { $lte: this.now() - SWEEP_GRACE_MS } },
        { projection: { _id: 1, 'youtube.current.qid': 1 } },
      )
      .limit(100)
      .toArray();
    let advanced = 0;
    for (const r of due) {
      const qid = r.youtube?.current?.qid;
      if (!qid) continue;
      try {
        const res = await this.write(r._id, (s, now) =>
          atEnd(s, qid, now, 0) ? advance(s, now) : null,
        );
        if (res.changed) advanced++;
      } catch (err) {
        this.ctx.log.warn({ err, roomId: String(r._id) }, 'youtube sweep failed');
      }
    }
    return advanced;
  }

  /**
   * Applies [change] with an update conditional on the rev it read, retrying on a concurrent
   * write. [change] returns null for "nothing to do", which writes and sends nothing.
   */
  private async write(
    roomId: ObjectId,
    change: (s: YouTubeStateDoc, now: number) => YouTubeStateDoc | null,
  ): Promise<{ state: YouTubeStateDoc; now: number; changed: boolean }> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const room = await this.ctx.col.liveRooms.findOne({ _id: roomId, status: 'live' });
      if (!room) throw new AppError(410, 'room_ended', 'This live has ended');
      const state = room.youtube ?? EMPTY_YOUTUBE;
      const now = this.now();
      const next = change(state, now);
      if (!next) return { state, now, changed: false };
      const written: YouTubeStateDoc = { ...next, rev: state.rev + 1 };
      const guard = room.youtube ? { 'youtube.rev': state.rev } : { youtube: null };
      const res = await this.ctx.col.liveRooms.updateOne(
        { _id: roomId, status: 'live', ...guard },
        { $set: { youtube: written } },
      );
      if (res.matchedCount === 0) continue;
      await this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.youtube, {
          youtube: youtubeView(written),
          serverNow: now,
        })
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'youtube broadcast failed'));
      return { state: written, now, changed: true };
    }
    throw conflict('Someone else changed the music, try again', 'busy');
  }
}
