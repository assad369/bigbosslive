import type { Config } from './config.js';

export type DeletionResult = 'sent' | 'rate_limited' | 'error';

/** Sends a web account-deletion request to the API. Never throws. */
export type DeletionSubmitter = (
  input: { contact: string; reason: string },
  clientIp: string | null,
) => Promise<DeletionResult>;

const TIMEOUT_MS = 5000;

/** `POST /v1/account-deletion-requests`, rate limited per visitor when the service key matches. */
export function apiDeletionSubmitter(c: Config, fetchFn: typeof fetch = fetch): DeletionSubmitter {
  return async (input, clientIp) => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (c.LINK_SERVICE_KEY) {
      headers['x-link-service-key'] = c.LINK_SERVICE_KEY;
      if (clientIp) headers['x-client-ip'] = clientIp;
    }
    try {
      const res = await fetchFn(`${c.API_INTERNAL_URL}/v1/account-deletion-requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) return 'rate_limited';
      return res.ok ? 'sent' : 'error';
    } catch {
      return 'error';
    }
  };
}
