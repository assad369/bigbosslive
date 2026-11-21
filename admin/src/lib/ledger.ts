import type { LedgerReason } from '@bigboss/shared';

/** How a ledger reason reads to staff, and the colour of its tag. */
export const LEDGER_REASON_LABELS: Record<LedgerReason, { label: string; color: string }> = {
  gift_sent: { label: 'Gift sent', color: 'magenta' },
  gift_received: { label: 'Gift received', color: 'green' },
  agency_commission: { label: 'Agency commission', color: 'cyan' },
  recharge_agent: { label: 'Recharge (agent)', color: 'blue' },
  recharge_admin: { label: 'Recharge (admin)', color: 'blue' },
  recharge_iap: { label: 'Recharge (in-app purchase)', color: 'blue' },
  agent_stock_topup: { label: 'Agent stock top-up', color: 'geekblue' },
  agent_stock_transfer: { label: 'Agent stock sold', color: 'geekblue' },
  vip_purchase: { label: 'Tier package purchase', color: 'gold' },
  cosmetic_purchase: { label: 'Decoration purchase', color: 'gold' },
  game_bet: { label: 'Game bet', color: 'purple' },
  game_payout: { label: 'Game win', color: 'purple' },
  game_refund: { label: 'Game refund', color: 'purple' },
  game_cashback: { label: 'Game cashback', color: 'purple' },
  game_reversal: { label: 'Game claw-back', color: 'purple' },
  game_wallet_deposit: { label: 'Moved to game wallet', color: 'purple' },
  game_wallet_withdraw: { label: 'Back from game wallet', color: 'purple' },
  withdrawal_hold: { label: 'Withdrawal requested', color: 'orange' },
  withdrawal_release: { label: 'Withdrawal returned', color: 'orange' },
  admin_adjustment: { label: 'Admin correction', color: 'red' },
  currency_merge: { label: 'Beans merged into diamonds', color: 'default' },
  coin_bag_release: { label: 'Coin bag released', color: 'orange' },
  coin_bag_grab: { label: 'Coin bag grabbed', color: 'green' },
  coin_bag_refund: { label: 'Coin bag refund', color: 'blue' },
};

export function ledgerReason(reason: string): { label: string; color: string } {
  return (
    LEDGER_REASON_LABELS[reason as LedgerReason] ?? {
      label: reason.replace(/_/g, ' '),
      color: 'default',
    }
  );
}
