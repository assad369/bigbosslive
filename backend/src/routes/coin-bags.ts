import { Router } from 'express';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/http.js';
import {
  currentUser,
  idParam,
  idempotencyKey,
  parseBody,
  parseParams,
  toObjectId,
} from '../lib/http.js';
import { releaseCoinBagInput } from '../modules/coin-bags/coin-bags.service.js';

/** Coin bags in lives: release, grab, and the lists the app polls on (re)connect. */
export function coinBagRoutes(ctx: Ctx): Router {
  const r = Router();
  // Scoped to this prefix so unknown /v1 paths still fall through to 404.
  r.use(['/coin-bags'], requireAuth(ctx));
  const { coinBags } = ctx.services;
  const releaseLimit = createRateLimiter(ctx.redis, {
    windowMs: 60_000,
    limit: 5,
    prefix: 'coin-bag-release',
    byUser: true,
  });
  const grabLimit = createRateLimiter(ctx.redis, {
    windowMs: 10_000,
    limit: 20,
    prefix: 'coin-bag-grab',
    byUser: true,
  });

  r.get('/coin-bags/config', async (req, res) => {
    res.json(await coinBags.config(currentUser(req).uid));
  });

  r.get('/coin-bags/active', async (req, res) => {
    res.json(await coinBags.active(currentUser(req).uid));
  });

  r.post('/coin-bags', releaseLimit, async (req, res) => {
    const input = parseBody(req, releaseCoinBagInput);
    res.json(await coinBags.release(currentUser(req).uid, idempotencyKey(req), input));
  });

  r.get('/coin-bags/:id', async (req, res) => {
    const { id } = parseParams(req, idParam);
    res.json(await coinBags.detail(toObjectId(id), currentUser(req).uid));
  });

  r.post('/coin-bags/:id/grab', grabLimit, async (req, res) => {
    const { id } = parseParams(req, idParam);
    res.json(await coinBags.grab(currentUser(req).uid, toObjectId(id)));
  });

  return r;
}
