import { LIVEKIT_TOPICS, YT_QUEUE_MAX } from '@bigboss/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataApiYouTube, isoDurationSec, videoFromApi } from '../src/infra/youtube.js';
import { ytRefusal } from '../src/modules/youtube/eligibility.js';
import { looksLikeVideoId, parseYouTubeUrl } from '../src/modules/youtube/url.js';
import { rebased, startPlaying, ytPosition } from '../src/modules/youtube/youtube.state.js';
import { createHarness, type Harness } from './helpers/harness.js';

const ID = 'dQw4w9WgXcQ';

describe('youtube pure helpers', () => {
  it('parseYouTubeUrl reads every common link form', () => {
    const ok = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
      `youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&feature=share`,
      `https://youtu.be/${ID}?si=abc`,
      `youtu.be/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=share`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `  https://youtu.be/${ID}  `,
    ];
    for (const u of ok) expect(parseYouTubeUrl(u), u).toBe(ID);
    const bad = [
      'despacito',
      `https://evil.com/watch?v=${ID}`,
      `https://youtube.com.evil.com/watch?v=${ID}`,
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/playlist?list=PL123',
      `javascript://youtu.be/${ID}`,
      '',
    ];
    for (const u of bad) expect(parseYouTubeUrl(u), u).toBeNull();
    expect(looksLikeVideoId(ID)).toBe(true);
    expect(looksLikeVideoId('hello world')).toBe(false);
  });

  it('isoDurationSec and videoFromApi read the Data API', () => {
    expect(isoDurationSec('PT3M33S')).toBe(213);
    expect(isoDurationSec('PT1H2M3S')).toBe(3723);
    expect(isoDurationSec('P1DT1S')).toBe(86_401);
    expect(isoDurationSec('nonsense')).toBe(0);
    const v = videoFromApi({
      id: ID,
      snippet: { title: 'T', channelTitle: 'C', channelId: 'UCx', liveBroadcastContent: 'none' },
      contentDetails: {
        duration: 'PT4M',
        contentRating: { ytRating: 'ytAgeRestricted' },
        regionRestriction: { blocked: ['BD'] },
      },
      status: { embeddable: true, privacyStatus: 'public' },
    });
    expect(v).toMatchObject({
      videoId: ID,
      durationSec: 240,
      ageRestricted: true,
      regionBlocked: ['BD'],
      regionAllowed: null,
      embeddable: true,
    });
    expect(videoFromApi({})).toBeNull();
  });

  it('ytRefusal applies the player limits and our policy', () => {
    const base = {
      videoId: ID,
      title: 't',
      channel: 'c',
      channelId: 'UCc',
      durationSec: 200,
      embeddable: true,
      privacyStatus: 'public',
      liveBroadcastContent: 'none',
      ageRestricted: false,
      regionAllowed: null,
      regionBlocked: null,
    };
    const rules = {
      regionCode: 'BD',
      maxDurationSec: 900,
      blockedVideoIds: [] as string[],
      blockedChannelIds: [] as string[],
    };
    expect(ytRefusal(base, rules)).toBeNull();
    expect(ytRefusal({ ...base, embeddable: false }, rules)).toBe('not_embeddable');
    expect(ytRefusal({ ...base, privacyStatus: 'private' }, rules)).toBe('not_public');
    expect(ytRefusal({ ...base, liveBroadcastContent: 'live', durationSec: 0 }, rules)).toBe(
      'live_video',
    );
    expect(ytRefusal({ ...base, ageRestricted: true }, rules)).toBe('age_restricted');
    expect(ytRefusal({ ...base, regionBlocked: ['BD'] }, rules)).toBe('region_blocked');
    expect(ytRefusal({ ...base, regionAllowed: ['US'] }, rules)).toBe('region_blocked');
    expect(ytRefusal({ ...base, regionAllowed: ['US'] }, { ...rules, regionCode: '' })).toBeNull();
    expect(ytRefusal({ ...base, durationSec: 901 }, rules)).toBe('too_long');
    expect(ytRefusal(base, { ...rules, blockedChannelIds: ['UCc'] })).toBe('blocked');
  });

  it('ytPosition follows the server clock; rebased recomputes endsAt', () => {
    const item = {
      qid: 'q',
      videoId: ID,
      title: 't',
      channel: 'c',
      durationSec: 60,
      addedBy: { uid: 'u', displayName: 'U' },
    };
    const cur = startPlaying(item, 1000);
    expect(cur.endsAt).toBe(61_000);
    expect(ytPosition(cur, 6000)).toBe(5000);
    expect(ytPosition(cur, 1e9)).toBe(60_000);
    const paused = rebased(cur, 11_000, { playing: false });
    expect(paused).toMatchObject({ playing: false, positionMs: 10_000, endsAt: null });
    expect(ytPosition(paused, 99_000)).toBe(10_000);
    expect(rebased(paused, 20_000, { playing: true }).endsAt).toBe(70_000);
  });
});

describe('DataApiYouTube', () => {
  const replying = (status: number, body: unknown) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const googleError = (reason: string, message: string) => ({
    error: { code: 403, message, errors: [{ reason, message }] },
  });

  it("names Google's reason when the key is refused", async () => {
    const { fetchImpl } = replying(
      403,
      googleError('accessNotConfigured', 'YouTube Data API v3 has not been used in project 1.'),
    );
    const err = await new DataApiYouTube('k', fetchImpl)
      .search('q', { safeSearch: 'moderate' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'youtube_unavailable' });
    expect((err as Error).message).toContain('accessNotConfigured');
  });

  it('reads a spent quota as youtube_quota', async () => {
    const { fetchImpl } = replying(403, googleError('quotaExceeded', 'Quota exceeded.'));
    await expect(
      new DataApiYouTube('k', fetchImpl).search('q', { safeSearch: 'moderate' }),
    ).rejects.toMatchObject({ code: 'youtube_quota' });
  });

  it('refuses without calling YouTube when no key is set', async () => {
    const { calls, fetchImpl } = replying(200, {});
    await expect(new DataApiYouTube(undefined, fetchImpl).videos([ID])).rejects.toMatchObject({
      code: 'youtube_unavailable',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('youtube music in a live', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    for (const uid of ['host', 'fan', 'adm', 'boss']) await h.user(uid);
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.ctx.col.liveRooms.deleteMany({});
    await h.ctx.col.youtubeCache.deleteMany({});
    await h.ctx.col.auditLogs.deleteMany({});
    await h.ctx.services.config.set('features', { youtubeEnabled: true }, 'boss');
    await h.ctx.services.config.set('youtube', {}, 'boss');
    h.youtube.videosById.clear();
    h.youtube.results.clear();
    h.youtube.calls.length = 0;
    h.youtube.failing = false;
    h.youtube.quota = false;
    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', ID])
      h.youtube.add({ videoId: id });
    h.livekit.data.length = 0;
  });

  const goLive = async () => {
    const res = await h.api.post('/v1/live').set(h.as('host')).send({ title: 'yt', type: 'video' });
    return res.body.room.id as string;
  };
  const cmd = (uid: string, roomId: string, body: object, role?: 'admin') =>
    h.api.post(`/v1/live/${roomId}/youtube`).set(h.as(uid, role)).send(body);
  const ended = (uid: string, roomId: string, qid: string) =>
    h.api.post(`/v1/live/${roomId}/youtube/ended`).set(h.as(uid)).send({ qid });
  const search = (uid: string, roomId: string, q: string) =>
    h.api.get(`/v1/live/${roomId}/youtube/search`).query({ q }).set(h.as(uid));
  const packets = () => h.livekit.data.filter((d) => d.topic === LIVEKIT_TOPICS.youtube);
  const state = async () => (await h.ctx.col.liveRooms.findOne({ status: 'live' }))!.youtube!;

  it('the host, room admins and staff control it; viewers cannot', async () => {
    const roomId = await goLive();
    expect((await cmd('fan', roomId, { action: 'play', videoId: ID })).status).toBe(403);
    expect((await search('fan', roomId, 'song')).status).toBe(403);

    const played = await cmd('host', roomId, { action: 'play', videoId: ID });
    expect(played.status).toBe(200);
    expect(played.body.youtube.current).toMatchObject({
      videoId: ID,
      playing: true,
      positionMs: 0,
      title: `Song ${ID}`,
      addedBy: { uid: 'host' },
    });
    expect(played.body.youtube.current.endsAt).toBeUndefined();
    expect(played.body.youtube.rev).toBe(1);
    expect(typeof played.body.serverNow).toBe('number');
    expect(packets()).toHaveLength(1);
    expect(packets()[0]!.payload).toMatchObject({ youtube: { rev: 1 } });

    await h.api
      .post(`/v1/live/${roomId}/moderators`)
      .set(h.as('host'))
      .send({ userId: 'adm', enabled: true })
      .expect(204);
    const paused = await cmd('adm', roomId, { action: 'pause' });
    expect(paused.body.youtube.current.playing).toBe(false);

    // Staff acting in someone else's live leave an audit trail; the host and room admins don't.
    await cmd('boss', roomId, { action: 'resume' }, 'admin').expect(200);
    const actions = (await h.ctx.col.auditLogs.find({}).toArray()).map((a) => [
      a.adminId,
      a.action,
    ]);
    expect(actions).toEqual([['boss', 'youtube.resume']]);

    // A late joiner reads the state from the room detail.
    const detail = await h.api.get(`/v1/live/${roomId}`).set(h.as('fan'));
    expect(detail.body.room.youtube).toMatchObject({ current: { videoId: ID, playing: true } });
  });

  it('the flag gates starting a song, never what is already playing', async () => {
    const roomId = await goLive();
    await cmd('host', roomId, { action: 'play', videoId: ID });
    await cmd('host', roomId, { action: 'enqueue', videoId: 'aaaaaaaaaaa' });
    await h.ctx.services.config.set('features', { youtubeEnabled: false }, 'boss');
    expect(
      (await cmd('host', roomId, { action: 'play', videoId: 'bbbbbbbbbbb' })).body.error.code,
    ).toBe('feature_off');
    expect((await search('host', roomId, 'x')).body.error.code).toBe('feature_off');
    expect((await cmd('host', roomId, { action: 'pause' })).status).toBe(200);
    const st = await state();
    const next = await cmd('host', roomId, { action: 'next', fromQid: st.current!.qid });
    expect(next.body.youtube.current.videoId).toBe('aaaaaaaaaaa');
    expect((await cmd('host', roomId, { action: 'stop' })).body.youtube.current).toBeNull();
  });

  it('refuses videos the official player or our policy would not play', async () => {
    const roomId = await goLive();
    h.youtube.add({ videoId: 'noembed0000', embeddable: false });
    h.youtube.add({ videoId: 'agerestrict', ageRestricted: true });
    h.youtube.add({ videoId: 'livestream0', liveBroadcastContent: 'live', durationSec: 0 });
    h.youtube.add({ videoId: 'longvideo00', durationSec: 3600 });
    const code = async (videoId: string) =>
      (await cmd('host', roomId, { action: 'play', videoId })).body.error?.code;
    expect(await code('noembed0000')).toBe('youtube_not_embeddable');
    expect(await code('agerestrict')).toBe('youtube_age_restricted');
    expect(await code('livestream0')).toBe('youtube_live_video');
    expect(await code('longvideo00')).toBe('youtube_too_long');
    expect(await code('unknown0000')).toBe('not_found');
    await h.ctx.services.config.set('youtube', { blockedVideoIds: [ID] }, 'boss');
    expect(await code(ID)).toBe('youtube_blocked');
    expect((await cmd('host', roomId, { action: 'play', videoId: 'not an id' })).status).toBe(422);
    expect(
      (await cmd('host', roomId, { action: 'play', videoId: ID, title: 'smuggled' })).status,
    ).toBe(422);
    expect(packets()).toHaveLength(0);
  });

  it('queues songs, refuses duplicates and a full queue, moves and removes by qid', async () => {
    const roomId = await goLive();
    await cmd('host', roomId, { action: 'enqueue', videoId: ID }); // nothing playing: starts now
    await cmd('host', roomId, { action: 'enqueue', videoId: 'aaaaaaaaaaa' });
    await cmd('host', roomId, { action: 'enqueue', videoId: 'bbbbbbbbbbb' });
    expect(
      (await cmd('host', roomId, { action: 'enqueue', videoId: 'aaaaaaaaaaa' })).body.error.code,
    ).toBe('already_queued');
    let st = await state();
    expect(st.current!.videoId).toBe(ID);
    expect(st.queue.map((q) => q.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);

    const ids = (r: { body: { youtube: { queue: { videoId: string }[] } } }) =>
      r.body.youtube.queue.map((q) => q.videoId);
    const moved = await cmd('host', roomId, { action: 'move', qid: st.queue[1]!.qid, toIndex: 0 });
    expect(ids(moved)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa']);
    const removed = await cmd('host', roomId, { action: 'remove', qid: st.queue[0]!.qid });
    expect(ids(removed)).toEqual(['bbbbbbbbbbb']);

    // A repeated skip (the song already changed) does nothing.
    st = await state();
    const before = packets().length;
    const skip = { action: 'next', fromQid: st.current!.qid };
    await cmd('host', roomId, skip);
    await cmd('host', roomId, skip);
    st = await state();
    expect(st.current!.videoId).toBe('bbbbbbbbbbb');
    expect(st.queue).toHaveLength(0);
    expect(packets().length).toBe(before + 1);

    for (let i = 0; i < YT_QUEUE_MAX; i++) {
      const id = `q${String(i).padStart(10, '0')}`;
      h.youtube.add({ videoId: id });
      expect((await cmd('host', roomId, { action: 'enqueue', videoId: id })).status).toBe(200);
    }
    h.youtube.add({ videoId: 'onetoomany0' });
    expect(
      (await cmd('host', roomId, { action: 'enqueue', videoId: 'onetoomany0' })).body.error.code,
    ).toBe('queue_full');
    expect((await cmd('host', roomId, { action: 'clearQueue' })).body.youtube.queue).toEqual([]);
  });

  it('advances only at the end on the server clock; the sweeper covers silence', async () => {
    const roomId = await goLive();
    await cmd('host', roomId, { action: 'play', videoId: ID });
    await cmd('host', roomId, { action: 'enqueue', videoId: 'aaaaaaaaaaa' });
    const first = (await state()).current!.qid;

    // Too early: a viewer can't use it to skip.
    const early = await ended('fan', roomId, first);
    expect(early.body.advanced).toBe(false);
    expect(early.body.youtube.current.videoId).toBe(ID);

    h.clock.advance(198); // 200 s song, within the 3 s slack
    const done = await ended('fan', roomId, first);
    expect(done.body.advanced).toBe(true);
    expect(done.body.youtube.current.videoId).toBe('aaaaaaaaaaa');
    expect((await ended('host', roomId, first)).body.advanced).toBe(false);

    // Nobody reported the end: the sweeper moves on once the grace has passed.
    h.clock.advance(202);
    expect(await h.ctx.services.youtube.sweep()).toBe(0);
    h.clock.advance(5);
    expect(await h.ctx.services.youtube.sweep()).toBe(1);
    const st = await state();
    expect(st.current).toBeNull();
    expect(st.queue).toEqual([]);
  });

  it('a paused song is never swept', async () => {
    const roomId = await goLive();
    await cmd('host', roomId, { action: 'play', videoId: ID });
    await cmd('host', roomId, { action: 'pause' });
    h.clock.advance(1000);
    expect(await h.ctx.services.youtube.sweep()).toBe(0);
    expect((await state()).current).toMatchObject({ videoId: ID, playing: false });
  });

  it('searches through a cache, resolves pasted links, and maps quota errors', async () => {
    const roomId = await goLive();
    h.youtube.results.set('lofi beats', ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    h.youtube.add({ videoId: 'bbbbbbbbbbb', embeddable: false });
    const first = await search('host', roomId, 'lofi beats');
    expect(first.body.items).toEqual([
      expect.objectContaining({ videoId: 'aaaaaaaaaaa', playable: true, reason: null }),
      expect.objectContaining({
        videoId: 'bbbbbbbbbbb',
        playable: false,
        reason: 'not_embeddable',
      }),
    ]);
    const calls = h.youtube.calls.length;
    expect((await search('host', roomId, '  LOFI   beats ')).body.items).toHaveLength(2);
    expect(h.youtube.calls.length).toBe(calls);

    const linked = await search('host', roomId, `https://youtu.be/${ID}?si=x`);
    expect(linked.body.items).toEqual([expect.objectContaining({ videoId: ID, playable: true })]);
    expect(h.youtube.calls.filter((c) => c.method === 'search')).toHaveLength(1);

    h.youtube.quota = true;
    const res = await search('host', roomId, 'something new');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('youtube_quota');
    h.youtube.quota = false;
    h.youtube.failing = true;
    expect((await search('host', roomId, 'another')).body.error.code).toBe('youtube_unavailable');
  });

  it('validates its settings whole', async () => {
    const put = (value: object) =>
      h.api.put('/v1/admin/config/youtube').set(h.as('boss', 'admin')).send(value);
    expect((await put({ safeSearch: 'off' })).status).toBe(400);
    expect((await put({ regionCode: 'Bangladesh' })).status).toBe(400);
    expect((await put({ regionCode: 'BD', safeSearch: 'strict' })).status).toBe(200);
  });
});
