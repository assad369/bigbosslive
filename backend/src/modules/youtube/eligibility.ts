import type { YtVideo } from '../../infra/youtube.js';

/** Why a video can't play in a live. Each is refused as 400 `youtube_<reason>`. */
export type YtRefusal =
  | 'not_embeddable'
  | 'not_public'
  | 'live_video'
  | 'age_restricted'
  | 'region_blocked'
  | 'too_long'
  | 'blocked';

export interface YtRules {
  /** ISO 3166-1 alpha-2, or '' to skip the region check. */
  regionCode: string;
  maxDurationSec: number;
  blockedVideoIds: readonly string[];
  blockedChannelIds: readonly string[];
}

export const REFUSAL_MESSAGES: Record<YtRefusal, string> = {
  not_embeddable: 'The owner of this video does not allow it to play in other apps',
  not_public: 'This video is private',
  live_video: 'Live streams and premieres can not be played',
  age_restricted: 'Age-restricted videos can not be played',
  region_blocked: 'This video is not available in your country',
  too_long: 'This video is too long',
  blocked: 'This video is not allowed',
};

/**
 * Whether [v] may play in a live, or why not. The official player refuses videos that are
 * not embeddable, private, live or age-restricted, so we refuse them first; the rest is the
 * platform's own policy. Pure.
 */
export function ytRefusal(v: YtVideo, rules: YtRules): YtRefusal | null {
  if (rules.blockedVideoIds.includes(v.videoId) || rules.blockedChannelIds.includes(v.channelId))
    return 'blocked';
  if (!v.embeddable) return 'not_embeddable';
  if (v.privacyStatus !== 'public' && v.privacyStatus !== 'unlisted') return 'not_public';
  if (v.liveBroadcastContent !== 'none' || v.durationSec <= 0) return 'live_video';
  if (v.ageRestricted) return 'age_restricted';
  const region = rules.regionCode.toUpperCase();
  if (region) {
    if (v.regionBlocked?.includes(region)) return 'region_blocked';
    if (v.regionAllowed && !v.regionAllowed.includes(region)) return 'region_blocked';
  }
  if (v.durationSec > rules.maxDurationSec) return 'too_long';
  return null;
}
