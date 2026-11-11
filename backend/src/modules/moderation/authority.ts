import type { AdminRole, MeModeration } from '@bigboss/shared';
import type { UserDoc } from '../../db/schema.js';
import { hasPermission } from '../../middleware/rbac.js';
import type { ConfigValue } from '../config/config.service.js';

/**
 * Who may moderate from inside the app. The single place these rules live: routes, services
 * and `/me.moderation` all ask here, so the app's controls and the server's checks can't
 * drift apart.
 *
 * Two kinds of people moderate in the app:
 * - **Platform moderators**: app users with `users.platformModerator`, granted by an admin.
 *   The flag is read from the user document `requireAuth` loads on every request, so a revoke
 *   applies on the next request. It never grants dashboard access.
 * - **Staff** holding `live.moderate` / `users.moderate` through the token's `adminRole`
 *   claim (never the Mongo mirror).
 */

export function isPlatformModerator(u: Pick<UserDoc, 'platformModerator'>): boolean {
  return Boolean(u.platformModerator);
}

/** May remove, ban, mute and delete chat in any live room, and end any live. */
export function canModerateLive(
  u: Pick<UserDoc, 'platformModerator'>,
  tokenRole: AdminRole | null,
): boolean {
  return isPlatformModerator(u) || hasPermission(tokenRole, 'live.moderate');
}

/** May use the in-app Moderation panel (search, ban, devices, live bans). */
export function canModerateUsers(
  u: Pick<UserDoc, 'platformModerator'>,
  tokenRole: AdminRole | null,
): boolean {
  return isPlatformModerator(u) || hasPermission(tokenRole, 'users.moderate');
}

/**
 * Accounts nobody but staff may act on: staff themselves and platform moderators. A host or
 * room admin can't remove them from a live, and a platform moderator can't ban one another.
 * Uses the Mongo `adminRole` mirror because it describes the *target*, whose token we don't
 * have; it is re-synced from the claim on every `/auth/session`.
 */
export function isProtected(u: Pick<UserDoc, 'adminRole' | 'platformModerator'>): boolean {
  return Boolean(u.adminRole) || isPlatformModerator(u);
}

/** The `/me.moderation` block; null for anyone who moderates nothing. */
export function moderationFor(
  u: Pick<UserDoc, 'platformModerator'>,
  tokenRole: AdminRole | null,
  cfg: ConfigValue<'platformModerators'>,
): MeModeration | null {
  const live = canModerateLive(u, tokenRole);
  const platform = isPlatformModerator(u);
  if (!live && !platform) return null;
  return {
    isPlatformModerator: platform,
    canModerateLive: live,
    // Stealth and self-stage belong to the flag, not to staff: staff join visibly.
    stealthEnabled: platform && cfg.stealthEnabled,
    selfStageEnabled: platform && cfg.selfStageEnabled,
  };
}
