import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import client from 'prom-client';
import type { Ctx } from './context.js';
import {
  createRateLimiter,
  errorHandler,
  metrics,
  notFoundHandler,
  requestId,
} from './middleware/http.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { contentRoutes } from './routes/content.js';
import { economyRoutes } from './routes/economy.js';
import { liveRoutes, livekitWebhookRoute } from './routes/live.js';
import { socialRoutes } from './routes/social.js';
import { docsRoutes } from './routes/docs.js';

export function createApp(ctx: Ctx): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.env.TRUST_PROXY);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (req) => (req as express.Request).requestId ?? '',
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Lean access logs: no headers (they carry tokens and are huge), just the essentials.
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          ip: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
      },
    }),
  );
  app.use(metrics());
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) =>
        cb(
          null,
          !origin || ctx.env.CORS_ORIGINS.includes(origin) || ctx.env.NODE_ENV !== 'production',
        ),
      credentials: false,
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
        'X-Device-Id',
        'X-Platform',
        'X-App-Build',
        'X-Request-Id',
      ],
      maxAge: 600,
    }),
  );
  app.use(compression());

  // Probes and metrics: unauthenticated, no rate limit.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const [mongo, redis] = await Promise.all([
      ctx.db.ping(),
      ctx.redis
        ? ctx.redis
            .ping()
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(true),
    ]);
    res.status(mongo && redis ? 200 : 503).json({ mongo, redis });
  });
  app.get('/metrics', async (req, res) => {
    // Scraped from inside the cluster; refuse public traffic arriving through the proxy.
    if (ctx.env.NODE_ENV === 'production' && req.header('x-forwarded-for')) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', client.register.contentType);
    res.send(await client.register.metrics());
  });

  // Webhooks need the raw body for signature checks — mount before express.json().
  app.use('/v1/webhooks', livekitWebhookRoute(ctx));

  app.use(express.json({ limit: '256kb' }));
  app.use('/v1', createRateLimiter(ctx.redis, { windowMs: 60_000, limit: 600, prefix: 'global' }));

  app.use('/v1', accountRoutes(ctx));
  app.use('/v1', contentRoutes(ctx));
  app.use('/v1/live', liveRoutes(ctx));
  app.use('/v1', economyRoutes(ctx));
  app.use('/v1', socialRoutes(ctx));
  app.use('/v1/admin', adminRoutes(ctx));
  if (ctx.env.NODE_ENV !== 'production') app.use('/docs', docsRoutes());

  app.use(notFoundHandler());
  app.use(errorHandler(ctx.log));
  return app;
}
