import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

/** What we read about a video from the YouTube Data API. */
export interface YtVideo {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  /** 0 for live streams and premieres. */
  durationSec: number;
  embeddable: boolean;
  /** 'public' | 'unlisted' | 'private' */
  privacyStatus: string;
  /** 'none' | 'live' | 'upcoming' */
  liveBroadcastContent: string;
  ageRestricted: boolean;
  /** ISO 3166-1 alpha-2 codes, when YouTube restricts the video by region. */
  regionAllowed: string[] | null;
  regionBlocked: string[] | null;
}

export interface YtSearchOptions {
  pageToken?: string;
  regionCode?: string;
  safeSearch: 'none' | 'moderate' | 'strict';
}

export interface YtSearchPage {
  ids: string[];
  nextPageToken: string | null;
}

/**
 * The YouTube Data API v3. Failures throw a 503 [AppError] with code `youtube_quota` (daily
 * quota spent) or `youtube_unavailable` (no key, a bad key, a timeout or an outage).
 */
export interface YouTubeGateway {
  readonly configured: boolean;
  /** Embeddable, syndicated videos matching [q]. Costs 100 quota units. */
  search(q: string, opts: YtSearchOptions): Promise<YtSearchPage>;
  /** Details of up to 50 videos; unknown or deleted ids are left out. Costs 1 unit. */
  videos(ids: readonly string[]): Promise<YtVideo[]>;
}

export const youtubeUnavailable = (message = 'YouTube is not available right now') =>
  new AppError(503, 'youtube_unavailable', message);
export const youtubeQuota = () =>
  new AppError(503, 'youtube_quota', 'YouTube search is busy right now. Paste a link instead.');

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") in seconds; 0 when unparseable. Pure. */
export function isoDurationSec(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso ?? '');
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Math.floor(Number(s ?? 0))
  );
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;

/** One `videos.list` item as a [YtVideo]. Pure. */
export function videoFromApi(item: unknown): YtVideo | null {
  const it = obj(item);
  const videoId = str(it.id);
  if (!videoId) return null;
  const snippet = obj(it.snippet);
  const details = obj(it.contentDetails);
  const status = obj(it.status);
  const region = obj(details.regionRestriction);
  return {
    videoId,
    title: str(snippet.title),
    channel: str(snippet.channelTitle),
    channelId: str(snippet.channelId),
    durationSec: isoDurationSec(str(details.duration)),
    embeddable: status.embeddable === true,
    privacyStatus: str(status.privacyStatus),
    liveBroadcastContent: str(snippet.liveBroadcastContent) || 'none',
    ageRestricted: obj(details.contentRating).ytRating === 'ytAgeRestricted',
    regionAllowed: strs(region.allowed),
    regionBlocked: strs(region.blocked),
  };
}

const API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_FIELDS =
  'items(id,snippet(title,channelTitle,channelId,liveBroadcastContent),contentDetails(duration,contentRating/ytRating,regionRestriction),status(embeddable,privacyStatus))';
const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

export class DataApiYouTube implements YouTubeGateway {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return Boolean(this.apiKey);
  }

  async search(q: string, opts: YtSearchOptions): Promise<YtSearchPage> {
    const params: Record<string, string> = {
      part: 'id',
      type: 'video',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '20',
      safeSearch: opts.safeSearch,
      q,
      fields: 'nextPageToken,items/id/videoId',
    };
    if (opts.regionCode) params.regionCode = opts.regionCode;
    if (opts.pageToken) params.pageToken = opts.pageToken;
    const body = await this.get('search', params);
    const items = Array.isArray(body.items) ? body.items : [];
    return {
      ids: items.map((i) => str(obj(obj(i).id).videoId)).filter(Boolean),
      nextPageToken: str(body.nextPageToken) || null,
    };
  }

  async videos(ids: readonly string[]): Promise<YtVideo[]> {
    if (ids.length === 0) return [];
    const body = await this.get('videos', {
      part: 'snippet,contentDetails,status',
      id: ids.slice(0, 50).join(','),
      fields: VIDEO_FIELDS,
    });
    const items = Array.isArray(body.items) ? body.items : [];
    return items.map(videoFromApi).filter((v): v is YtVideo => v !== null);
  }

  private async get(path: string, params: Record<string, string>): Promise<Json> {
    if (!this.apiKey) throw youtubeUnavailable();
    const q = new URLSearchParams({ ...params, key: this.apiKey });
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/${path}?${q}`, {
        signal: AbortSignal.timeout(8_000),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw youtubeUnavailable('YouTube is not responding, try again');
    }
    const body = obj(await res.json().catch(() => null));
    if (res.ok) return body;
    const error = obj(body.error);
    const reasons = (Array.isArray(error.errors) ? (error.errors as unknown[]) : []).map((e) =>
      str(obj(e).reason),
    );
    if (reasons.some((r) => QUOTA_REASONS.has(r))) throw youtubeQuota();
    // Google's own text names the cause: API disabled, key restricted, key invalid.
    const why = str(error.message).slice(0, 200);
    throw youtubeUnavailable(
      `YouTube refused the request (${res.status} ${reasons.join(',') || 'error'})${why ? `: ${why}` : ''}`,
    );
  }
}

export function createYouTubeGateway(env: Env): YouTubeGateway {
  return new DataApiYouTube(env.YOUTUBE_API_KEY);
}
