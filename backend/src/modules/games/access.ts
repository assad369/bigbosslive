import type { GameLock } from '@bigboss/shared';
import type { GameCatalogDoc, UserDoc } from '../../db/schema.js';

export interface GamesSettings {
  /** `features.gamesEnabled`: the master switch. */
  enabled: boolean;
  minLevel: number;
  liveRoomEnabled: boolean;
  showLocked: boolean;
}

export type AccessUser = Pick<UserDoc, 'level' | 'status'> & {
  gamesBlock?: UserDoc['gamesBlock'];
};

/** A game is offered at all: on locally and still listed by the provider. */
export const isOffered = (game: GameCatalogDoc | null): game is GameCatalogDoc =>
  Boolean(game?.enabled && game.provider.available);

/** The level a game needs: its own override, else the global one. */
export const minLevelFor = (game: GameCatalogDoc | null, settings: GamesSettings): number =>
  game?.minLevel ?? settings.minLevel;

/**
 * Why `user` can't play `game` right now, or null. The one rule shared by the app's list,
 * launch and the wallet's stake gate (which passes `game: undefined` for a movement that
 * names no game, such as a transfer-wallet deposit, and never knows `inLive`). Pure.
 */
export function gameLock(input: {
  settings: GamesSettings;
  user: AccessUser;
  /** `undefined`: don't check a game (the movement has none). `null`: not in the catalogue. */
  game: GameCatalogDoc | null | undefined;
  inLive?: boolean;
}): GameLock | null {
  const { settings, user, game, inLive } = input;
  if (!settings.enabled) return { reason: 'disabled' };
  if (game !== undefined && !isOffered(game)) return { reason: 'disabled' };
  if (user.status !== 'active' || user.gamesBlock) return { reason: 'blocked' };
  if (inLive && (!settings.liveRoomEnabled || (game && !game.liveRoom)))
    return { reason: 'live_off' };
  const minLevel = minLevelFor(game ?? null, settings);
  if ((user.level?.level ?? 0) < minLevel) return { reason: 'level', minLevel };
  return null;
}

/** What the app shows for a lock. */
export function lockMessage(lock: GameLock): string {
  switch (lock.reason) {
    case 'level':
      return `Reach level ${lock.minLevel ?? 0} to play this game`;
    case 'blocked':
      return 'Games are not available for your account';
    case 'live_off':
      return "This game isn't available in live rooms";
    case 'disabled':
    default:
      return 'This game is not available right now';
  }
}
