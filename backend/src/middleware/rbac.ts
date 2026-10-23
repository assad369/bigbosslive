import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AdminRole } from '@bigboss/shared';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * Admin permission matrix. `superadmin` implicitly holds every permission. Keep this the
 * single place that decides who can do what in the dashboard; the admin UI reads the same
 * list from `GET /v1/admin/me` to hide what a role cannot use.
 */
export const PERMISSIONS = {
  'dashboard.view': ['support', 'moderator', 'finance', 'admin'],
  'users.read': ['support', 'moderator', 'finance', 'admin'],
  'users.moderate': ['moderator', 'admin'],
  'users.edit': ['admin'],
  'wallet.adjust': ['finance', 'admin'],
  'wallet.read': ['finance', 'admin', 'support'],
  'live.read': ['support', 'moderator', 'admin'],
  'live.moderate': ['moderator', 'admin'],
  'catalog.manage': ['admin'],
  'agents.manage': ['finance', 'admin'],
  'agencies.manage': ['finance', 'admin'],
  'withdrawals.read': ['finance', 'admin'],
  'withdrawals.review': ['finance', 'admin'],
  'reports.read': ['support', 'moderator', 'admin'],
  'reports.resolve': ['moderator', 'admin'],
  'feed.moderate': ['moderator', 'admin'],
  'devices.ban': ['moderator', 'admin'],
  'notifications.send': ['admin'],
  'games.manage': ['admin'],
  'games.read': ['finance', 'admin'],
  'config.manage': ['admin'],
  'audit.read': ['admin'],
  'admins.manage': [],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: AdminRole | null, permission: Permission): boolean {
  if (!role) return false;
  if (role === 'superadmin') return true;
  return (PERMISSIONS[permission] as readonly AdminRole[]).includes(role);
}

export function permissionsFor(role: AdminRole | null): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => hasPermission(role, p));
}

/** Mount after `requireAuth`. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (!hasPermission(req.auth.adminRole, permission)) throw forbidden();
    next();
  };
}

export function requireAnyAdmin(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (!req.auth.adminRole) throw forbidden('Admin access required');
    next();
  };
}
