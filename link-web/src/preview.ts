import type { Config } from './config.js';
import type { DeepLinkKind } from './contract.js';

export interface Person {
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** `GET /v1/share/preview/:kind/:id` (backend `modules/share`). */
export type Preview =
  | {
      kind: 'live';
      type: 'video' | 'audio';
      status: 'live' | 'ended';
      title: string;
      coverUrl: string | null;
      host: Person;
    }
  | { kind: 'user'; user: Person & { level: number; followers: number } }
  | { kind: 'post'; text: string; imageUrl: string | null; author: Person };

export type PreviewResult =
  { state: 'found'; data: Preview } | { state: 'not_found' } | { state: 'unavailable' };

export type PreviewFetcher = (
  kind: DeepLinkKind,
  id: string,
  clientIp: string | null,
) => Promise<PreviewResult>;

const TIMEOUT_MS = 3000;
const NOT_FOUND_TTL_MS = 60_000;
const MAX_ENTRIES = 2000;

/**
 * Reads anonymous previews from the API. Results are cached in memory for the API's
 * Cache-Control max-age (capped at 10 minutes; 404s for a minute), so a link going viral costs
 * one API call per window. Failures are never cached.
 */
export function apiPreviewFetcher(c: Config, fetchFn: typeof fetch = fetch): PreviewFetcher {
  const cache = new Map<string, { until: number; result: PreviewResult }>();

  const remember = (key: string, result: PreviewResult, ttlMs: number) => {
    if (ttlMs <= 0) return;
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + ttlMs, result });
  };

  return async (kind, id, clientIp) => {
    const key = `${kind}/${id}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.result;
    cache.delete(key);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (c.LINK_SERVICE_KEY) {
      headers['x-link-service-key'] = c.LINK_SERVICE_KEY;
      if (clientIp) headers['x-client-ip'] = clientIp;
    }
    try {
      const res = await fetchFn(
        `${c.API_INTERNAL_URL}/v1/share/preview/${kind}/${encodeURIComponent(id)}`,
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (res.status === 404) {
        const result: PreviewResult = { state: 'not_found' };
        remember(key, result, NOT_FOUND_TTL_MS);
        return result;
      }
      if (!res.ok) return { state: 'unavailable' };
      const body = (await res.json()) as { preview?: Preview };
      if (body.preview?.kind !== kind) return { state: 'unavailable' };
      const result: PreviewResult = { state: 'found', data: body.preview };
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0);
      remember(key, result, Math.min(maxAge, 600) * 1000);
      return result;
    } catch {
      return { state: 'unavailable' };
    }
  };
}
