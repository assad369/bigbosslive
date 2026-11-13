import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Ctx } from '../context.js';
import { createRateLimiter } from '../middleware/http.js';
import type { WalletCallType } from '../modules/games/game-wallet.service.js';

/** Constant-time string equality (hashing first makes the lengths equal). */
function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** The X-Signature AsadSoft sends: hex HMAC-SHA256 of the exact body bytes, keyed on apiSecret. */
export function signWalletBody(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * AsadSoft → BigBoss wallet callbacks, at `/v1/webhooks/asadsoft/{balance,debit,credit}`.
 * Mounted before the JSON parser: the signature is over the raw bytes, so they are never
 * re-serialised. Fails closed: with no secret or token configured, no money moves.
 *
 * Replies follow the provider's contract (`{ success, balance, data }` / `{ success: false,
 * error }`) rather than our usual error shape. A 4xx is a refusal AsadSoft never retries; a
 * 5xx (an infrastructure error, through the global error handler) is retried once with the
 * same bytes, and the txId dedupe makes that safe.
 */
export function asadsoftWalletRoutes(ctx: Ctx): Router {
  const r = Router();
  const secret = ctx.env.ASADSOFT_API_SECRET;
  const token = ctx.env.ASADSOFT_WALLET_TOKEN;
  const allowedIps = new Set(ctx.env.ASADSOFT_CALLBACK_IPS);

  // Authentication failures only, per IP: guessing the token or signature is capped, while
  // real traffic (all from AsadSoft's servers, refusals like 402 included) never is.
  r.use(
    createRateLimiter(ctx.redis, {
      windowMs: 60_000,
      limit: 30,
      prefix: 'asadsoft-wallet-fail',
      skipSuccessful: true,
      isFailure: (status) => status === 401,
    }),
  );

  const refuse = (res: Response, status: number, error: string) =>
    res.status(status).json({ success: false, error });

  function authorise(req: Request, res: Response, next: NextFunction) {
    if (!secret || !token) {
      refuse(res, 503, 'WALLET_NOT_CONFIGURED');
      return;
    }
    if (allowedIps.size > 0 && !allowedIps.has(req.ip ?? '')) {
      ctx.log.warn({ ip: req.ip }, 'asadsoft wallet call from an unlisted IP');
      refuse(res, 403, 'FORBIDDEN');
      return;
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer || !safeEqual(bearer, token)) {
      refuse(res, 401, 'UNAUTHORISED');
      return;
    }
    next();
  }

  r.get('/balance', authorise, async (req, res) => {
    const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : '';
    if (!playerId || playerId.length > 128) {
      refuse(res, 400, 'playerId required');
      return;
    }
    const out = await ctx.services.gameWallet.balance(playerId);
    res.status(out.status).json(out.body);
  });

  const raw = express.raw({ type: () => true, limit: '16kb' });
  for (const type of ['debit', 'credit'] as const satisfies readonly WalletCallType[]) {
    r.post(`/${type}`, authorise, raw, async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        refuse(res, 400, 'Body required');
        return;
      }
      const signature = String(req.headers['x-signature'] ?? '');
      if (!signature || !safeEqual(signature, signWalletBody(req.body, secret!))) {
        ctx.log.warn({ type }, 'asadsoft wallet call with a bad signature');
        refuse(res, 401, 'INVALID_SIGNATURE');
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(req.body.toString('utf8'));
      } catch {
        refuse(res, 400, 'Malformed JSON');
        return;
      }
      const out = await ctx.services.gameWallet.apply(type, body);
      const txId = (body as { txId?: unknown }).txId;
      ctx.log[out.status >= 400 ? 'warn' : 'info'](
        { type, txId, status: out.status, error: out.body.error },
        'asadsoft wallet call',
      );
      res.status(out.status).json(out.body);
    });
  }
  return r;
}
