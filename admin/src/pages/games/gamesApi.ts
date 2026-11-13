import type { Dayjs } from 'dayjs';
import type {
  AdminGame,
  GameMoney,
  GamesIntegrationStatus,
  GameTxKind,
  GameTxStatus,
} from '@bigboss/shared';
import { brand } from '../../theme';

export interface GamesSettings {
  enabled: boolean;
  minLevel: number;
  liveRoomEnabled: boolean;
  showLocked: boolean;
}

export interface GamesCatalogResponse {
  items: AdminGame[];
  settings: GamesSettings;
  integration: GamesIntegrationStatus;
}

/** Query keys, so every tab refreshes the same caches. */
export const GAMES_KEY = ['games'] as const;
export const GAMES_STATS_KEY = ['games-stats'] as const;
export const GAMES_TX_KEY = ['games-transactions'] as const;
export const GAMES_PLAYER_KEY = ['games-player'] as const;
export const GAMES_BLOCKED_KEY = ['games-blocked'] as const;

export const KIND_LABELS: Record<GameTxKind, string> = {
  stake: 'Stake',
  win: 'Win',
  refund: 'Refund',
  cashback: 'Cashback',
  rebate: 'Rebate',
  reversal: 'Claw-back',
  transfer_in: 'To game wallet',
  transfer_out: 'From game wallet',
  other_debit: 'Other debit',
  other_credit: 'Other credit',
};

export const STATUS_COLORS: Record<GameTxStatus, string> = {
  applied: 'green',
  reversed: 'orange',
  rejected: 'red',
  tombstone: 'default',
};

/** Green when the platform is up, red when players are. */
export const ggrColor = (ggr: number) =>
  ggr > 0 ? brand.palette.success : ggr < 0 ? brand.palette.danger : brand.palette.inkMuted;

/** Calendar day keys in the browser's zone; the server reports in its own timezone. */
export const dayStr = (d: Dayjs) => d.format('YYYY-MM-DD');

export const EMPTY_MONEY: GameMoney = {
  turnover: 0,
  payouts: 0,
  cashback: 0,
  ggr: 0,
  rtp: null,
  stakeCount: 0,
  winCount: 0,
  refunds: 0,
  reversals: 0,
  transfersIn: 0,
  transfersOut: 0,
  netFlow: 0,
};
