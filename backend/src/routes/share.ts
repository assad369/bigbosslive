import { timingSafeEqual } from 'node:crypto';
import { DEEP_LINK_ROUTES, type DeepLinkKind } from '@bigboss/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { parseBody, parseParams } from '../lib/http.js';
import { createRateLimiter } from '../middleware/http.js';
import { PREVIEW_MAX_AGE } from '../modules/share/share.service.js';
import { deletionRequestInput } from '../modules/users/deletion-requests.service.js';

const KINDS = DEEP_LINK_ROUTES.map((r) => r.kind) as [DeepLinkKind, ...DeepLinkKind[]];

const previewParams = z.object({
  kind: z.enum(KINDS),
  id: z.string().min(1).max(64),
});

/**
 * Unauthenticated routes link-web calls: share-link previews and the web account-deletion
 * form. Mounted ahead of the global `/v1` limit: every visitor arrives from link-web's one
 * address, so these keep their own limits, counted per visitor when link-web proves itself
 * with `LINK_SERVICE_KEY`.
 */
export function shareRoutes(ctx: Ctx): Router {
  const r = Router();
  const key = ctx.env.LINK_SERVICE_KEY ? Buffer.from(ctx.env.LINK_SERVICE_KEY) : null;

  const fromLinkService = (req: Request): boolean => {
    const given = req.header('x-link-service-key');
    if (!key || !given) return false;
    const buf = Buffer.from(given);
    return buf.length === key.length && timingSafeEqual(buf, key);
  };

  const visitor = (req: Request) =>
    (fromLinkService(req) && req.header('x-client-ip')) || req.ip || 'anon';

  r.use(
    '/share',
    createRateLimiter(ctx.redis, {
      windowMs: 60_000,
      limit: 60,
      prefix: 'share',
      keyGenerator: visitor,
    }),
  );

  // Play's account-deletion URL posts here (link-web `/delete-account`). The answer never
  // says whether an account matched, so it can't be used to look accounts up.
  r.post(
    '/account-deletion-requests',
    createRateLimiter(ctx.redis, {
      windowMs: 60 * 60_000,
      limit: 5,
      prefix: 'deletion-request',
      keyGenerator: visitor,
    }),
    async (req, res) => {
      const input = parseBody(req, deletionRequestInput);
      const ip = visitor(req);
      await ctx.services.deletionRequests.create(input, ip === 'anon' ? null : ip);
      res.status(202).json({ received: true });
    },
  );

  r.get('/share/preview/:kind/:id', async (req, res) => {
    const { kind, id } = parseParams(req, previewParams);
    const preview = await ctx.services.share.preview(kind, id);
    res.set('Cache-Control', `public, max-age=${PREVIEW_MAX_AGE[kind]}`);
    res.json({ preview });
  });

  return r;
}
