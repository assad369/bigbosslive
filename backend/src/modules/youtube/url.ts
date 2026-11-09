/** A YouTube video id: 11 characters of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const WATCH_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Path forms that carry the id as their second segment: /shorts/<id>, /embed/<id>, … */
const ID_PATHS = new Set(['shorts', 'embed', 'live', 'v', 'e']);

/**
 * The video id in a pasted YouTube link, or null when [text] isn't one.
 * Accepts watch, youtu.be, shorts, embed and live links on the www, m,
 * music and nocookie hosts, with or without a scheme. Pure.
 */
export function parseYouTubeUrl(text: string): string | null {
  const s = text.trim();
  if (s.length === 0 || s.length > 2048 || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | null | undefined;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = segments[0];
  } else if (WATCH_HOSTS.has(host)) {
    if (segments[0] === 'watch') id = url.searchParams.get('v');
    else if (segments[0] && ID_PATHS.has(segments[0])) id = segments[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/**
 * Whether [text] could be a bare video id. Ordinary words can look like
 * one too ("hello_world"), so callers look it up and fall back to a
 * search when YouTube doesn't know it. Pure.
 */
export function looksLikeVideoId(text: string): boolean {
  return VIDEO_ID.test(text.trim());
}
