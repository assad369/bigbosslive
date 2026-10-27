import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import client from 'prom-client';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

export const httpDuration = new client.Histogram({
  name: 'bb_http_request_duration_seconds',
  help: 'HTTP request duration by route and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export function metrics(): RequestHandler {
  return (req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      // Route pattern (not raw URL) keeps label cardinality bounded.
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(new AppError(404, 'route_not_found', 'Route not found'));
}

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    // Malformed JSON from express.json()
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      err = new AppError(400, 'invalid_json', 'Malformed JSON body');
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { type?: string }).type === 'entity.too.large'
    ) {
      err = new AppError(413, 'payload_too_large', 'Request body too large');
    }
    if (err instanceof AppError) {
      if (err.status >= 500) log.error({ err, requestId: req.requestId }, err.message);
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          requestId: req.requestId,
        },
      });
      return;
    }
    log.error({ err, requestId: req.requestId, path: req.path }, 'unhandled error');
    res.status(500).json({
      error: { code: 'internal', message: 'Something went wrong', requestId: req.requestId },
    });
  };
}

export interface RateLimitOpts {
  windowMs: number;
  limit: number;
  prefix: string;
  /** Key by authenticated uid when available, else client IP. */
  byUser?: boolean;
  /** Count only failed (4xx/5xx) requests, e.g. for passcode guesses. */
  skipSuccessful?: boolean;
}

export function createRateLimiter(redis: Redis | null, opts: RateLimitOpts): RequestHandler {
  const config: Partial<Options> = {
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: opts.skipSuccessful ?? false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'rate_limited', 'Too many requests, slow down')),
    ...(opts.byUser ? { keyGenerator: (req: Request) => req.auth?.uid ?? req.ip ?? 'anon' } : {}),
  };
  if (redis) {
    config.store = new RedisStore({
      prefix: `rl:${opts.prefix}:`,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<RedisReply>,
    });
  }
  return rateLimit(config);
}
