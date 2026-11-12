import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_LEVEL, buildDefaultLevels } from '@bigboss/shared';
import { LevelsService } from '../src/modules/levels/levels.service.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.user('boss', { adminRole: 'admin' });
});
afterAll(async () => h.close());

describe('default level ladder', () => {
  const levels = buildDefaultLevels();

  it('has 500 strictly increasing levels in the bdlive_pro bands', () => {
    expect(levels).toHaveLength(MAX_LEVEL);
    expect(levels.map((l) => l.level)).toEqual(Array.from({ length: MAX_LEVEL }, (_, i) => i + 1));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.pointsRequired).toBeGreaterThan(levels[i - 1]!.pointsRequired);
    }
    const at = (l: number) => levels[l - 1]!;
    expect(at(1)).toMatchObject({ pointsRequired: 100_000, name: 'Bronze', color: '#CD7F32' });
    expect(at(10).pointsRequired).toBe(1_000_000);
    expect(at(11)).toMatchObject({ pointsRequired: 1_500_000, name: 'Silver' });
    expect(at(15).pointsRequired).toBe(3_500_000);
    expect(at(20)).toMatchObject({ pointsRequired: 503_500_000, name: 'Gold' });
    expect(at(21).name).toBe('Diamond');
    expect(at(500)).toMatchObject({ pointsRequired: 96_503_500_000, name: 'Supreme' });
  });

  it('saves through the admin API and levels users at the band edges', async () => {
    const res = await h.api
      .put('/v1/admin/levels')
      .set(h.as('boss', 'admin'))
      .send({ items: levels });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(MAX_LEVEL);

    const configs = await h.ctx.services.levels.configs();
    expect(configs).toHaveLength(MAX_LEVEL);
    expect(LevelsService.levelFor(99_999, configs)).toBe(0);
    expect(LevelsService.levelFor(100_000, configs)).toBe(1);
    expect(LevelsService.levelFor(503_499_999, configs)).toBe(19);
    expect(LevelsService.levelFor(503_500_000, configs)).toBe(20);
    expect(LevelsService.levelFor(96_503_500_000, configs)).toBe(500);
    expect(LevelsService.levelFor(Number.MAX_SAFE_INTEGER, configs)).toBe(500);
  });

  it('rejects a level above the cap', async () => {
    const last = levels.at(-1)!;
    const res = await h.api
      .put('/v1/admin/levels')
      .set(h.as('boss', 'admin'))
      .send({
        items: [{ ...last, level: MAX_LEVEL + 1, pointsRequired: last.pointsRequired + 1 }],
      });
    expect(res.status).toBe(422);
  });
});
