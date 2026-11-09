import express, { Router } from 'express';
import type { Ctx } from '../context.js';
import { InvalidWebhookSignatureError, type WebhookEvent } from '../infra/sightguard.js';
import { notFound, unauthorized } from '../lib/errors.js';

/**
 * SightGuard → BigBoss verdicts. Authenticated by the HMAC signature over the raw body, so it
 * is mounted before the JSON body parser. A handler failure answers 500 and SightGuard
 * retries the delivery.
 */
export function sightguardWebhookRoute(ctx: Ctx): Router {
  const r = Router();
  r.post('/sightguard', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    if (!ctx.sightguard.enabled) throw notFound();
    if (!Buffer.isBuffer(req.body)) throw unauthorized('Invalid webhook signature');
    let event: WebhookEvent;
    try {
      event = ctx.sightguard.verifyWebhook(req.body, req.headers);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError)
        throw unauthorized('Invalid webhook signature');
      throw err;
    }
    const processed = await ctx.services.sightguardEvents.handle(event);
    res.status(200).json({ ok: true, duplicate: !processed });
  });
  return r;
}
