import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AdminRole } from '@bigboss/shared';
import type { Ctx } from '../context.js';
import type { UserDoc } from '../db/schema.js';
import { AppError, unauthorized } from '../lib/errors.js';
import type { VerifiedToken } from '../infra/firebase.js';

export interface AuthUser {
  uid: string;
  token: VerifiedToken;
  /** Admin role from the verified custom claim — the claim, not the Mongo mirror, is authoritative. */
  adminRole: AdminRole | null;
  user: UserDoc;
  deviceId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser;
    /** Set by `requireToken` for the session bootstrap route, before a user document exists. */
    token?: VerifiedToken;
    requestId?: string;
  }
}

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function normalizeDeviceId(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9_\-:.]{6,128}$/.test(id) ? id : null;
}

async function verify(ctx: Ctx, req: Request): Promise<VerifiedToken> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  try {
    return await ctx.auth.verifyIdToken(token);
  } catch {
    throw unauthorized('Invalid or expired session');
  }
}

/** Verifies the Firebase ID token only. Used by `POST /v1/auth/session` to create the profile. */
export function requireToken(ctx: Ctx): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.token = await verify(ctx, req);
    next();
  };
}

/**
 * Verifies the token, loads the user, and enforces account and device bans. Every user-facing
 * route except session bootstrap sits behind this.
 */
export function requireAuth(ctx: Ctx): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = await verify(ctx, req);
    const user = await ctx.col.users.findOne({ _id: token.uid });
    if (!user || user.status === 'deleted') {
      throw new AppError(401, 'profile_required', 'Create a profile via POST /v1/auth/session first');
    }
    const now = ctx.clock.now();
    if (user.status === 'banned') {
      if (user.ban?.until && user.ban.until <= now) {
        await ctx.services.users.liftExpiredBan(user._id);
        user.status = 'active';
        user.ban = null;
      } else {
        throw new AppError(403, 'account_banned', 'This account is banned', {
          reason: user.ban?.reason ?? null,
          until: user.ban?.until ?? null,
        });
      }
    }

    const deviceId = normalizeDeviceId(req.header('x-device-id'));
    if (deviceId && (await ctx.services.moderation.isDeviceBanned(deviceId))) {
      throw new AppError(403, 'device_banned', 'This device is banned');
    }

    req.auth = { uid: user._id, token, adminRole: token.adminRole, user, deviceId };

    if (now.getTime() - user.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      // Fire-and-forget: presence bookkeeping must never fail a request.
      void ctx.services.users.touch(user._id, deviceId, req.header('x-platform') ?? null).catch((err: unknown) =>
        ctx.log.warn({ err }, 'touch failed'),
      );
    }
    next();
  };
}
