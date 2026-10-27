import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { currentUser, parseBody, parseQuery } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';

const MB = 1024 * 1024;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const UPLOAD_KINDS = {
  avatar: { folder: 'avatars', types: IMAGES, maxBytes: 5 * MB },
  cover: { folder: 'covers', types: IMAGES, maxBytes: 5 * MB },
  post: { folder: 'posts', types: [...IMAGES, 'video/mp4'], maxBytes: 50 * MB },
  chat: { folder: 'chat', types: IMAGES, maxBytes: 10 * MB },
  report: { folder: 'reports', types: IMAGES, maxBytes: 10 * MB },
} as const;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

/** Public app configuration, level ladder, banners and upload presigning. */
export function contentRoutes(ctx: Ctx): Router {
  const r = Router();
  const auth = requireAuth(ctx);
  const { config, levels, banners, gifts } = ctx.services;

  /** Unauthenticated: the app reads this before sign-in (maintenance, force-update). */
  r.get('/config/app', async (_req, res) => {
    const [app, features, pk] = await Promise.all([
      config.get('app'),
      config.get('features'),
      config.get('pk'),
    ]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ app, features, pk: { durationsSec: pk.durationsSec }, livekitUrl: ctx.livekit.url });
  });

  r.get('/levels', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ items: await levels.configs() });
  });

  r.get('/banners', auth, async (req, res) => {
    const { placement } = parseQuery(
      req,
      z.object({ placement: z.enum(['home', 'live', 'wallet', 'games']).default('home') }),
    );
    res.json({ items: await banners.active(placement) });
  });

  r.get('/leaderboards/:kind', auth, async (req, res) => {
    const { kind } = z.object({ kind: z.enum(['rich', 'charm']) }).parse(req.params);
    const { period } = parseQuery(
      req,
      z.object({ period: z.enum(['day', 'week', 'month']).default('day') }),
    );
    const days = { day: 1, week: 7, month: 30 }[period];
    res.json({
      items: await gifts.leaderboard(kind, new Date(ctx.clock.now().getTime() - days * 86_400_000)),
    });
  });

  r.post('/uploads/presign', auth, async (req, res) => {
    const { kind, contentType, size } = parseBody(
      req,
      z.object({
        kind: z.enum(Object.keys(UPLOAD_KINDS) as [keyof typeof UPLOAD_KINDS]),
        contentType: z.string(),
        /** Optional for older app builds; when sent, the size is capped and signed. */
        size: z.number().int().positive().optional(),
      }),
    );
    const spec = UPLOAD_KINDS[kind];
    if (!(spec.types as readonly string[]).includes(contentType))
      throw badRequest(`Unsupported content type for ${kind}`);
    if (size !== undefined && size > spec.maxBytes)
      throw badRequest(`File is too large (max ${spec.maxBytes / MB} MB)`);
    res.json(
      await ctx.storage.presignUpload({
        folder: spec.folder,
        ownerId: currentUser(req).uid,
        contentType,
        ext: EXT[contentType]!,
        ...(size !== undefined ? { contentLength: size } : {}),
      }),
    );
  });

  return r;
}
