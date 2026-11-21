import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

let n = 0;
async function goLive(opts: { agency?: boolean; type?: 'video' | 'audio' } = {}) {
  n++;
  const uid = `cam-host-${n}`;
  await h.user(uid);
  if (opts.agency !== false) {
    await h.ctx.col.users.updateOne({ _id: uid }, { $set: { agencyId: new ObjectId() } });
  }
  const { room } = await h.ctx.services.live.start(uid, {
    type: opts.type ?? 'video',
    title: 'Camera',
    coverUrl: null,
    tags: [],
  });
  const doc = (await h.ctx.col.liveRooms.findOne({ _id: new ObjectId(room.id) }))!;
  return { uid, id: doc._id, livekitRoom: doc.livekitRoom };
}

const camera = (room: string, uid: string, state: 'on' | 'off' | 'absent' | 'error') =>
  h.livekit.cameras.set(`${room}/${uid}`, state);

/** Advance the clock and run the sweep, keeping heartbeats fresh so only the camera rule acts. */
async function tick(sec: number, ...rooms: ObjectId[]) {
  h.clock.advance(sec);
  await h.ctx.col.liveRooms.updateMany(
    { _id: { $in: rooms } },
    { $set: { lastHeartbeatAt: h.ctx.clock.now() } },
  );
  return h.ctx.services.live.sweepCameraOff();
}

const status = async (id: ObjectId) => (await h.ctx.col.liveRooms.findOne({ _id: id }))!;

describe('agency host camera-off rule', () => {
  it('warns the host once, then ends the live after 5 minutes off', async () => {
    const r = await goLive();
    camera(r.livekitRoom, r.uid, 'off');
    h.livekit.data = [];
    const warnings = () =>
      h.livekit
        .topics('bb.system')
        .filter((d) => (d.payload as { kind: string }).kind === 'camera_off_warning');
    await tick(1, r.id); // starts counting, and tells the host how long they have
    expect((await status(r.id)).cameraOffSince).toBeInstanceOf(Date);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.identities).toEqual([r.uid]);
    expect(warnings()[0]!.payload).toMatchObject({ endsInSec: 300, limitSec: 300 });
    await tick(200, r.id);
    expect(warnings()).toHaveLength(1);

    await tick(45, r.id); // 245 s off: inside the last minute
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]!.identities).toEqual([r.uid]);
    expect(warnings()[1]!.payload).toMatchObject({ endsInSec: 55 });
    await tick(15, r.id);
    expect(warnings()).toHaveLength(2);
    expect((await status(r.id)).status).toBe('live');

    expect(await tick(40, r.id)).toBe(1); // 300 s
    const ended = await status(r.id);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'camera_off', endedBy: 'system' });
    expect(h.livekit.topics('bb.room.ended').at(-1)!.payload).toMatchObject({
      reason: 'camera_off',
    });
    const audit = await h.ctx.col.auditLogs.findOne({
      action: 'live.camera_off_end',
      targetId: String(r.id),
    });
    expect(audit?.adminId).toBe('system');
  });

  it('starts over when the camera comes back on', async () => {
    const r = await goLive();
    camera(r.livekitRoom, r.uid, 'off');
    await tick(1, r.id);
    await tick(250, r.id);
    camera(r.livekitRoom, r.uid, 'on');
    await tick(15, r.id);
    expect((await status(r.id)).cameraOffSince).toBeNull();
    camera(r.livekitRoom, r.uid, 'off');
    await tick(15, r.id);
    await tick(200, r.id);
    expect((await status(r.id)).status).toBe('live');
    await h.ctx.services.live.end(r.id, 'host', r.uid);
  });

  it('leaves non-agency hosts, audio lives, absent hosts and LiveKit outages alone', async () => {
    const solo = await goLive({ agency: false });
    const audio = await goLive({ type: 'audio' });
    const away = await goLive();
    const outage = await goLive();
    camera(solo.livekitRoom, solo.uid, 'off');
    camera(audio.livekitRoom, audio.uid, 'off');
    camera(away.livekitRoom, away.uid, 'absent');
    camera(outage.livekitRoom, outage.uid, 'error');
    const ids = [solo.id, audio.id, away.id, outage.id];
    await tick(1, ...ids);
    expect(await tick(400, ...ids)).toBe(0);
    for (const id of ids) {
      const room = await status(id);
      expect(room.status).toBe('live');
      expect(room.cameraOffSince ?? null).toBeNull();
    }
    for (const r of [solo, audio, away, outage]) await h.ctx.services.live.end(r.id, 'host', r.uid);
  });

  it('is off when the limit is 0', async () => {
    const live = await h.ctx.services.config.get('live');
    await h.ctx.services.config.set('live', { ...live, agencyCameraOffEndSec: 0 }, 'test');
    const r = await goLive();
    camera(r.livekitRoom, r.uid, 'off');
    await tick(1, r.id);
    expect(await tick(1000, r.id)).toBe(0);
    expect((await status(r.id)).status).toBe('live');
    await h.ctx.services.config.set('live', live, 'test');
    await h.ctx.services.live.end(r.id, 'host', r.uid);
  });
});
