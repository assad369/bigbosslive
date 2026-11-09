import { describe, expect, it } from 'vitest';
import { signWebhook } from '@sightguard/sdk';
import { loadEnv } from '../src/config/env.js';
import {
  createSightGuardGateway,
  InvalidWebhookSignatureError,
  ModerationUnavailableError,
} from '../src/infra/sightguard.js';

const KEY = `sg_live_abcdefghijkl_${'x'.repeat(43)}`;
const SECRET = 'whsec_test_secret_123';
const env = (over: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://unused',
    SIGHTGUARD_ENABLED: 'true',
    SIGHTGUARD_API_URL: 'https://sg.test',
    SIGHTGUARD_API_KEY: KEY,
    SIGHTGUARD_WEBHOOK_SECRET: SECRET,
    SIGHTGUARD_LIVEKIT_CONNECTION_ID: 'lkc_1',
    ...over,
  });

type Call = { url: string; init: RequestInit };
const fetchReplying = (status: number, body: unknown, calls: Call[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

describe('SightGuard gateway', () => {
  it('is disabled unless enabled and configured', () => {
    const off = createSightGuardGateway(loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://x' }));
    expect(off.enabled).toBe(false);
    expect(() =>
      loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://x', SIGHTGUARD_ENABLED: 'true' }),
    ).toThrow(/SIGHTGUARD_API_URL/);
  });

  it('maps verdicts and sends channel, user and metadata', async () => {
    const calls: Call[] = [];
    const sg = createSightGuardGateway(
      env(),
      fetchReplying(200, { decision: 'reject', reasons: [{ category: 'text.insult' }] }, calls),
    );
    const v = await sg.moderateText('bad', {
      channel: 'comment',
      userRef: 'u1',
      metadata: { type: 'comment', commentId: 'c1' },
    });
    expect(v).toEqual({ decision: 'reject', categories: ['text.insult'] });
    expect(calls[0]!.url).toBe('https://sg.test/v1/moderate/text');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      text: 'bad',
      channel: 'comment',
      userRef: 'u1',
      metadata: { type: 'comment', commentId: 'c1' },
    });
  });

  it('moderates images by URL', async () => {
    const calls: Call[] = [];
    const sg = createSightGuardGateway(env(), fetchReplying(200, { decision: 'review' }, calls));
    const v = await sg.moderateImageUrl('https://cdn.test/a.webp', {
      channel: 'avatar',
      userRef: 'u',
    });
    expect(v.decision).toBe('review');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      url: 'https://cdn.test/a.webp',
      channel: 'avatar',
    });
  });

  it('reports outages and undecodable media as unavailable', async () => {
    const down = createSightGuardGateway(
      env(),
      fetchReplying(503, { error: { code: 'INFERENCE_UNAVAILABLE', message: 'down' } }),
    );
    const err = await down.moderateText('x', { channel: 'comment', userRef: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(ModerationUnavailableError);
    expect((err as ModerationUnavailableError).invalidMedia).toBe(false);

    const invalid = createSightGuardGateway(
      env(),
      fetchReplying(422, { error: { code: 'INVALID_MEDIA', message: 'not an image' } }),
    );
    const bad = await invalid
      .moderateImageUrl('https://cdn.test/x', { channel: 'avatar', userRef: 'u' })
      .catch((e) => e);
    expect((bad as ModerationUnavailableError).invalidMedia).toBe(true);

    const refused = createSightGuardGateway(
      env(),
      fetchReplying(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } }),
    );
    const e401 = await refused.moderateText('x', { channel: 'c', userRef: 'u' }).catch((e) => e);
    expect(e401).not.toBeInstanceOf(ModerationUnavailableError);
  });

  it('skips live supervision without a LiveKit connection id', async () => {
    const calls: Call[] = [];
    const sg = createSightGuardGateway(
      env({ SIGHTGUARD_LIVEKIT_CONNECTION_ID: '' }),
      fetchReplying(200, {}, calls),
    );
    expect(sg.liveEnabled).toBe(false);
    await sg.startLive({ room: 'bb_h_1', hostIdentity: 'h' });
    expect(calls).toEqual([]);

    const live = createSightGuardGateway(env(), fetchReplying(200, {}, calls));
    await live.startLive({ room: 'bb_h_1', hostIdentity: 'h', metadata: { roomId: 'r' } });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      connectionId: 'lkc_1',
      room: 'bb_h_1',
      hostIdentity: 'h',
      channel: 'live_stream',
    });
  });

  it('verifies webhook signatures over the raw body', () => {
    const sg = createSightGuardGateway(env());
    const body = JSON.stringify({ id: 'evt_1', type: 'ping', data: { message: 'hi' } });
    const ts = Math.floor(Date.now() / 1000);
    const event = sg.verifyWebhook(Buffer.from(body), {
      'sightguard-signature': signWebhook(SECRET, ts, body),
      'sightguard-timestamp': String(ts),
    });
    expect(event.id).toBe('evt_1');
    expect(() =>
      sg.verifyWebhook(Buffer.from(body), {
        'sightguard-signature': signWebhook('wrong-secret-0000000', ts, body),
        'sightguard-timestamp': String(ts),
      }),
    ).toThrow(InvalidWebhookSignatureError);
    // Replays outside the tolerance window are refused.
    expect(() =>
      sg.verifyWebhook(Buffer.from(body), {
        'sightguard-signature': signWebhook(SECRET, ts - 3600, body),
        'sightguard-timestamp': String(ts - 3600),
      }),
    ).toThrow(InvalidWebhookSignatureError);
  });
});
