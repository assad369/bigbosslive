import {
  SightGuard,
  SightGuardError,
  verifyWebhook,
  WebhookVerificationError,
  type WebhookEvent,
} from '@sightguard/sdk';
import type { Env } from '../config/env.js';

export type {
  LiveViolationData,
  ReviewCompletedData,
  VideoJob,
  WebhookEvent,
} from '@sightguard/sdk';

/** Flat values only: SightGuard echoes metadata back on webhooks. */
export type ModerationMetadata = Record<string, string>;

export interface ModerationVerdict {
  decision: 'allow' | 'review' | 'reject';
  /** Category ids of the reasons, e.g. `nudity.explicit`, `text.insult`. */
  categories: string[];
}

export interface ModerationRequest {
  /** Selects the SightGuard policy (thresholds, fail mode) for this kind of content. */
  channel: string;
  /** Opaque user id (uid), never a name or e-mail. */
  userRef: string;
  metadata?: ModerationMetadata;
  timeoutMs?: number;
}

/**
 * SightGuard could not give a verdict in time (timeout, network, 429, 5xx), or refused the
 * media as undecodable (`invalidMedia`, HTTP 422). The policy service picks the fail mode.
 */
export class ModerationUnavailableError extends Error {
  override readonly name = 'ModerationUnavailableError';
  constructor(
    message: string,
    readonly invalidMedia = false,
  ) {
    super(message);
  }
}

export class InvalidWebhookSignatureError extends Error {
  override readonly name = 'InvalidWebhookSignatureError';
}

/**
 * Everything the backend asks of SightGuard, the self-hosted moderation platform. Calls
 * either return a verdict or throw: `ModerationUnavailableError` when no verdict could be
 * had, anything else for a request SightGuard refused (a bug on our side).
 */
export interface SightGuardGateway {
  /** False when SightGuard is not configured: every check allows and nothing is sent. */
  readonly enabled: boolean;
  /** True when live streams can be supervised (a LiveKit connection id is set). */
  readonly liveEnabled: boolean;
  moderateText(text: string, req: ModerationRequest): Promise<ModerationVerdict>;
  /** SightGuard fetches the image itself: uploads go straight to the bucket, not via the API. */
  moderateImageUrl(url: string, req: ModerationRequest): Promise<ModerationVerdict>;
  /** Async: the verdict arrives as a `video.completed` webhook. */
  submitVideo(url: string, req: ModerationRequest): Promise<void>;
  /** Starts supervising a LiveKit room. Idempotent per room. */
  startLive(input: {
    room: string;
    hostIdentity: string;
    metadata?: ModerationMetadata;
  }): Promise<void>;
  endLive(room: string): Promise<void>;
  /** Verifies the HMAC signature over the raw body and parses the event. */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent;
}

export const disabledSightGuard: SightGuardGateway = {
  enabled: false,
  liveEnabled: false,
  moderateText: async () => ({ decision: 'allow', categories: [] }),
  moderateImageUrl: async () => ({ decision: 'allow', categories: [] }),
  submitVideo: async () => undefined,
  startLive: async () => undefined,
  endLive: async () => undefined,
  verifyWebhook() {
    throw new InvalidWebhookSignatureError('SightGuard webhooks are not configured');
  },
};

export function createSightGuardGateway(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): SightGuardGateway {
  const { SIGHTGUARD_API_URL: baseUrl, SIGHTGUARD_API_KEY: apiKey } = env;
  if (!env.SIGHTGUARD_ENABLED || !baseUrl || !apiKey) return disabledSightGuard;
  const secret = env.SIGHTGUARD_WEBHOOK_SECRET;
  const connectionId = env.SIGHTGUARD_LIVEKIT_CONNECTION_ID;
  const client = new SightGuard({ apiKey, baseUrl, timeoutMs: 5000, retries: 1, fetch: fetchImpl });

  const verdict = (r: { decision: string; reasons?: { category: string }[] }) => ({
    decision: (r.decision === 'reject' || r.decision === 'review'
      ? r.decision
      : 'allow') as ModerationVerdict['decision'],
    categories: (r.reasons ?? []).map((x) => x.category),
  });

  /** Retryable failures become `ModerationUnavailableError`; the rest are rethrown. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SightGuardError) {
        if (e.retryable) throw new ModerationUnavailableError(e.message);
        if (e.status === 422) throw new ModerationUnavailableError(e.message, true);
      }
      throw e;
    }
  }

  return {
    enabled: true,
    liveEnabled: Boolean(connectionId),
    async moderateText(text, { channel, userRef, metadata, timeoutMs }) {
      const r = await call(() =>
        client.moderateText(
          { text, channel, userRef, metadata },
          { fallback: 'throw', timeoutMs: timeoutMs ?? 2000 },
        ),
      );
      return verdict(r);
    },
    async moderateImageUrl(url, { channel, userRef, metadata, timeoutMs }) {
      const r = await call(() =>
        client.moderateImage(
          { url, channel, userRef, metadata },
          { fallback: 'throw', timeoutMs: timeoutMs ?? 8000 },
        ),
      );
      return verdict(r);
    },
    async submitVideo(url, { channel, userRef, metadata }) {
      await call(() => client.moderateVideo({ url, channel, userRef, metadata }));
    },
    async startLive({ room, hostIdentity, metadata }) {
      if (!connectionId) return;
      await call(() =>
        client.live.start({
          connectionId,
          room,
          hostIdentity,
          hostRef: hostIdentity,
          channel: 'live_stream',
          metadata,
        }),
      );
    },
    async endLive(room) {
      if (!connectionId) return;
      await call(() => client.live.endByRoom(connectionId, room));
    },
    verifyWebhook(rawBody, headers) {
      if (!secret) throw new InvalidWebhookSignatureError('SightGuard webhooks are not configured');
      try {
        return verifyWebhook(rawBody, headers, secret);
      } catch (e) {
        if (e instanceof WebhookVerificationError)
          throw new InvalidWebhookSignatureError(e.message);
        throw e;
      }
    },
  };
}
