import type { YouTubeState, YtItem } from '@bigboss/shared';
import type { YouTubeStateDoc, YtNowPlayingDoc } from '../../db/schema.js';

export const EMPTY_YOUTUBE: YouTubeStateDoc = { current: null, queue: [], rev: 0 };

type Clocked = Pick<YtNowPlayingDoc, 'playing' | 'positionMs' | 'updatedAt' | 'durationSec'>;

/** Where playback is at [now] (ms). Pure. Mirrors the app's `ytPositionMs`. */
export function ytPosition(s: Clocked, now: number): number {
  const at = s.playing ? s.positionMs + Math.max(0, now - s.updatedAt) : s.positionMs;
  return Math.min(Math.max(0, at), s.durationSec * 1000);
}

/** [cur] with its clock moved to [now]: position re-based and `endsAt` recomputed. Pure. */
export function rebased(
  cur: YtNowPlayingDoc,
  now: number,
  patch: { playing?: boolean; positionMs?: number } = {},
): YtNowPlayingDoc {
  const playing = patch.playing ?? cur.playing;
  const positionMs = Math.min(
    Math.max(0, patch.positionMs ?? ytPosition(cur, now)),
    cur.durationSec * 1000,
  );
  return {
    ...cur,
    playing,
    positionMs,
    updatedAt: now,
    endsAt: playing ? now + (cur.durationSec * 1000 - positionMs) : null,
  };
}

/** [item] starting from the top at [now]. Pure. */
export function startPlaying(item: YtItem, now: number): YtNowPlayingDoc {
  return {
    ...item,
    playing: true,
    positionMs: 0,
    updatedAt: now,
    endsAt: now + item.durationSec * 1000,
  };
}

/** The next queued song plays; the queue moves up. Pure. */
export function advance(s: YouTubeStateDoc, now: number): YouTubeStateDoc {
  const [head, ...rest] = s.queue;
  return { ...s, current: head ? startPlaying(head, now) : null, queue: rest };
}

/** Whether [qid] is playing and within [slackMs] of its end. Pure. */
export function atEnd(s: YouTubeStateDoc, qid: string, now: number, slackMs: number): boolean {
  const cur = s.current;
  if (!cur || cur.qid !== qid || !cur.playing) return false;
  // Unclamped: the sweeper asks about a point past the end.
  return cur.positionMs + Math.max(0, now - cur.updatedAt) >= cur.durationSec * 1000 - slackMs;
}

/** The state as clients see it (no `endsAt`). Pure. */
export function youtubeView(s: YouTubeStateDoc | null | undefined): YouTubeState | null {
  if (!s) return null;
  let current: YouTubeState['current'] = null;
  if (s.current) {
    const { endsAt: _endsAt, ...rest } = s.current;
    current = rest;
  }
  return { current, queue: s.queue, rev: s.rev };
}
