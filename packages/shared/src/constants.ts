/** Admin roles carried as a Firebase custom claim (`adminRole`). Ordered by privilege. */
export const ADMIN_ROLES = ['support', 'moderator', 'finance', 'admin', 'superadmin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const USER_STATUSES = ['active', 'banned', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROOM_TYPES = ['video', 'audio'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ROOM_STATUSES = ['live', 'ended'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** Spendable diamonds, withdrawable beans (gift earnings), and an agent's resale stock. */
export const CURRENCIES = ['diamonds', 'beans', 'agent_stock'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const LEDGER_REASONS = [
  'gift_sent',
  'gift_received',
  'agency_commission',
  'recharge_agent',
  'recharge_admin',
  'recharge_iap',
  'agent_stock_topup',
  'agent_stock_transfer',
  'vip_purchase',
  'cosmetic_purchase',
  'game_bet',
  'game_payout',
  'game_refund',
  'withdrawal_hold',
  'withdrawal_release',
  'admin_adjustment',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const PK_STATUSES = [
  'pending',
  'active',
  'ended',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type PkStatus = (typeof PK_STATUSES)[number];

export const GAME_KEYS = ['golden_wheel', 'teen_patti', 'fortune_ferris'] as const;
export type GameKey = (typeof GAME_KEYS)[number];

export const REPORT_TARGETS = ['user', 'room', 'post', 'comment', 'message'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const WITHDRAWAL_STATUSES = ['pending', 'approved', 'rejected', 'paid'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const COSMETIC_TYPES = [
  'frame',
  'entry_animation',
  'room_background',
  'chat_bubble',
] as const;
export type CosmeticType = (typeof COSMETIC_TYPES)[number];

export const ANIMATION_FORMATS = ['none', 'svga', 'lottie', 'mp4'] as const;
export type AnimationFormat = (typeof ANIMATION_FORMATS)[number];

export const MESSAGE_TYPES = ['text', 'image', 'gift', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * Socket.IO namespaces and event names. Keep client and server in lock-step through this file.
 * The app namespace carries everything personal (chat, notifications, wallet) plus the live
 * room directory; the games namespace serves the WebView mini-games.
 */
export const SOCKET = {
  namespaces: { app: '/', games: '/games' },
  app: {
    /** Client → server: receive live-room directory updates. */
    subscribeRooms: 'rooms:subscribe',
    unsubscribeRooms: 'rooms:unsubscribe',
    roomUpserted: 'rooms:upserted',
    roomEnded: 'rooms:ended',
    chatMessage: 'chat:message',
    chatRead: 'chat:read',
    /** Client → server and relayed to the peer. */
    chatTyping: 'chat:typing',
    notification: 'notification:new',
    walletUpdated: 'wallet:updated',
  },
  games: {
    subscribe: 'game:subscribe',
    unsubscribe: 'game:unsubscribe',
    round: 'game:round',
    totals: 'game:totals',
    settled: 'game:settled',
  },
} as const;

/** Topics published on the LiveKit data channel by the server. */
export const LIVEKIT_TOPICS = {
  gift: 'bb.gift',
  chat: 'bb.chat',
  system: 'bb.system',
  kick: 'bb.kick',
  seats: 'bb.seats',
  pkInvitation: 'bb.pk.invitation',
  pkStarted: 'bb.pk.started',
  pkScore: 'bb.pk.score',
  pkEnded: 'bb.pk.ended',
  pkRejected: 'bb.pk.rejected',
  pkCancelled: 'bb.pk.cancelled',
  pkExpired: 'bb.pk.expired',
  entry: 'bb.entry',
  roomEnded: 'bb.room.ended',
} as const;
