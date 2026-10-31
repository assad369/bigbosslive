import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEEP_LINK_ROUTES } from '@bigboss/shared';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { apiPreviewFetcher, type PreviewFetcher, type PreviewResult } from './preview.js';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
const HOST = 'links.example.com';
const ROOM = '65f0c0ffee0123456789abcd';
const POST = '65f0c0ffee0123456789beef';
const UA = {
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    PUBLIC_HOST: HOST,
    ANDROID_SHA256_FINGERPRINTS: FP.toLowerCase(),
    APPLE_TEAM_ID: 'ABCDE12345',
    IOS_APP_STORE_ID: '6400000000',
    ...extra,
  });

const host = { shortId: '777', displayName: 'Mina', avatarUrl: 'https://cdn.example.com/a.webp' };

/** Fake API: records calls, answers from a table. */
function fakeFetcher(table: Record<string, PreviewResult>) {
  const calls: { kind: string; id: string; ip: string | null }[] = [];
  const fetcher: PreviewFetcher = async (kind, id, ip) => {
    calls.push({ kind, id, ip });
    return table[`${kind}/${id}`] ?? { state: 'not_found' };
  };
  return { fetcher, calls };
}

const get = (
  app: ReturnType<typeof createApp>,
  path: string,
  headers: Record<string, string> = {},
) => app.request(`https://${HOST}${path}`, { headers, redirect: 'manual' });

const has = (html: string, part: string) => assert.ok(html.includes(part), `missing: ${part}`);
const lacks = (html: string, part: string) => assert.ok(!html.includes(part), `found: ${part}`);

describe('config', () => {
  it('normalises fingerprints and derives store URLs and the iOS app id', () => {
    const c = config();
    assert.deepEqual(c.ANDROID_SHA256_FINGERPRINTS, [FP.toUpperCase()]);
    assert.equal(c.iosAppId, 'ABCDE12345.com.bigbosslive.bigbossLive');
    assert.equal(c.appStoreUrl, 'https://apps.apple.com/app/id6400000000');
    assert.equal(c.androidStoreUrl, null);
  });

  it('rejects malformed values and fails fast in production without signing data', () => {
    assert.throws(() => config({ ANDROID_SHA256_FINGERPRINTS: 'AB:CD' }), /ANDROID_SHA256/);
    assert.throws(() => config({ APPLE_TEAM_ID: 'todo' }), /APPLE_TEAM_ID/);
    assert.throws(
      () => config({ ANDROID_STORE_URL: 'http://example.com/app.apk' }),
      /ANDROID_STORE_URL/,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      /ANDROID_SHA256_FINGERPRINTS[\s\S]*LINK_SERVICE_KEY/,
    );
    // Blank compose values count as unset.
    assert.equal(config({ APPLE_TEAM_ID: '' }).iosAppId, null);
  });
});

describe('verification files', () => {
  const app = createApp(config(), fakeFetcher({}).fetcher);

  it('serves assetlinks.json as JSON, 200, no redirect', async () => {
    const r = await get(app, '/.well-known/assetlinks.json');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /^application\/json/);
    assert.deepEqual(await r.json(), [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.bigbosslive.bigboss_live',
          sha256_cert_fingerprints: [FP.toUpperCase()],
        },
      },
    ]);
  });

  it('serves the AASA for every shared prefix, in modern and legacy form', async () => {
    const prefixes = DEEP_LINK_ROUTES.map((r) => `/${r.prefix}/*`);
    for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
      const r = await get(app, path);
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        applinks: {
          details: { appIDs: string[]; components: { '/': string }[]; paths: string[] }[];
        };
      };
      const d = body.applinks.details[0]!;
      assert.deepEqual(d.appIDs, ['ABCDE12345.com.bigbosslive.bigbossLive']);
      assert.deepEqual(
        d.components.map((x) => x['/']),
        prefixes,
      );
      assert.deepEqual(d.paths, prefixes);
    }
  });

  it('never serves a placeholder AASA: 404 until the Team ID is configured', async () => {
    const bare = createApp(config({ APPLE_TEAM_ID: '' }), fakeFetcher({}).fetcher);
    assert.equal((await get(bare, '/.well-known/apple-app-site-association')).status, 404);
  });
});

describe('content pages', () => {
  const { fetcher, calls } = fakeFetcher({
    [`live/${ROOM}`]: {
      state: 'found',
      data: {
        kind: 'live',
        type: 'video',
        status: 'live',
        title: 'Friday night',
        coverUrl: 'https://cdn.example.com/c.webp',
        host,
      },
    },
    [`live/${'a'.repeat(24)}`]: {
      state: 'found',
      data: {
        kind: 'live',
        type: 'audio',
        status: 'ended',
        title: '',
        coverUrl: 'javascript:alert(1)',
        host: { ...host, avatarUrl: 'http://insecure/a.png' },
      },
    },
    'user/777': {
      state: 'found',
      data: {
        kind: 'user',
        user: { ...host, displayName: '<script>alert(1)</script>', level: 9, followers: 3 },
      },
    },
    [`post/${POST}`]: { state: 'unavailable' },
  });
  const app = createApp(config(), fetcher);

  it('live page: OG tags, canonical URL, Smart App Banner and the Android handoff', async () => {
    const r = await get(app, `/live/${ROOM}`, { 'user-agent': UA.android });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.startsWith('<!doctype html>'));
    has(html, '<meta property="og:title" content="Mina is live on BigBoss Live"');
    has(html, `<link rel="canonical" href="https://${HOST}/live/${ROOM}"`);
    has(html, `app-id=6400000000, app-argument=https://${HOST}/live/${ROOM}`);
    has(
      html,
      `href="intent://${HOST}/live/${ROOM}#Intent;scheme=https;package=com.bigbosslive.bigboss_live;S.browser_fallback_url=${encodeURIComponent(`https://${HOST}/live/${ROOM}?open=0`)};end"`,
    );
    has(html, '<script src="/assets/open.js" defer');
    assert.match(r.headers.get('cache-control')!, /max-age=30/);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
  });

  it('does not auto-open after a failed handoff, or on iPhone', async () => {
    const back = await (
      await get(app, `/live/${ROOM}?open=0`, { 'user-agent': UA.android })
    ).text();
    lacks(back, 'open.js');
    const ios = await (await get(app, `/live/${ROOM}`, { 'user-agent': UA.iphone })).text();
    lacks(ios, 'open.js');
    has(ios, 'https://apps.apple.com/app/id6400000000');
  });

  it('escapes names and drops unsafe image URLs', async () => {
    const user = await (await get(app, '/u/777')).text();
    lacks(user, '<script>alert(1)</script>');
    has(user, '&lt;script&gt;');
    const ended = await (await get(app, `/live/${'a'.repeat(24)}`)).text();
    has(ended, 'ENDED');
    lacks(ended, 'javascript:');
    lacks(ended, 'http://insecure');
    has(ended, 'href="/u/777"');
  });

  it('a preview outage still offers the app, uncached', async () => {
    const r = await get(app, `/post/${POST}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  it('404s for unknown prefixes and malformed ids without calling the API', async () => {
    const before = calls.length;
    assert.equal((await get(app, `/clips/${ROOM}`)).status, 404);
    assert.equal((await get(app, '/live/nope')).status, 404);
    assert.equal((await get(app, '/u/12')).status, 404);
    assert.equal(calls.length, before);
    assert.equal((await get(app, `/live/${'f'.repeat(24)}`)).status, 404);
  });

  it('passes the visitor IP from the proxy header (last hop)', async () => {
    await get(app, `/live/${ROOM}`, { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' });
    assert.equal(calls.at(-1)?.ip, '203.0.113.9');
  });
});

describe('preview fetcher', () => {
  it('reads the API, sends the service key and caches for max-age', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(
        JSON.stringify({ preview: { kind: 'user', user: { ...host, level: 1, followers: 0 } } }),
        { status: 200, headers: { 'cache-control': 'public, max-age=300' } },
      );
    }) as unknown as typeof fetch;
    const fetchPreview = apiPreviewFetcher(
      config({ API_INTERNAL_URL: 'http://api:3000', LINK_SERVICE_KEY: 'k'.repeat(32) }),
      fake,
    );
    assert.equal((await fetchPreview('user', '777', '203.0.113.9')).state, 'found');
    assert.equal((await fetchPreview('user', '777', null)).state, 'found');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, 'http://api:3000/v1/share/preview/user/777');
    assert.equal(seen[0]!.headers['x-link-service-key'], 'k'.repeat(32));
    assert.equal(seen[0]!.headers['x-client-ip'], '203.0.113.9');
  });

  it('treats errors as unavailable, uncached', async () => {
    let n = 0;
    const fake = (async () => {
      n++;
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const fetchPreview = apiPreviewFetcher(config(), fake);
    assert.equal((await fetchPreview('live', ROOM, null)).state, 'unavailable');
    assert.equal((await fetchPreview('live', ROOM, null)).state, 'unavailable');
    assert.equal(n, 2);
  });
});
