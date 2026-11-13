/** Admin roles carried as a Firebase custom claim (`adminRole`). Ordered by privilege. */
export const ADMIN_ROLES = ['support', 'moderator', 'finance', 'admin', 'superadmin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Dashboard (Firebase email) password length, enforced by the API and the admin forms. */
export const ADMIN_PASSWORD_MIN_LENGTH = 10;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

/**
 * Public numeric user id ("ID 200"). New accounts are numbered from {@link FIRST_SHORT_ID};
 * accounts created before the switch keep their 8-digit ids, and admins may assign vanity ids
 * from 1 upward ({@link ASSIGNABLE_SHORT_ID_PATTERN}). This is the pattern anything that
 * *accepts* a short id matches (lookups, search, share links): 1–12 digits.
 */
export const SHORT_ID_PATTERN = /^\d{1,12}$/;
/** What an admin may assign: 1–12 digits starting from 1, so no `0` and no leading zero. */
export const ASSIGNABLE_SHORT_ID_PATTERN = /^[1-9]\d{0,11}$/;
export const FIRST_SHORT_ID = 200;

export const USER_STATUSES = ['active', 'banned', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * The tier ladder: VIP < VVIP < Crown < King. A user's `vipTier` (0 = none) is the tier of the
 * tier package they are wearing; higher tiers outrank lower ones everywhere a ranking by
 * status applies (viewer lists, the Popular tab).
 */
export const VIP_TIERS = [
  { tier: 1, key: 'vip', label: 'VIP' },
  { tier: 2, key: 'vvip', label: 'VVIP' },
  { tier: 3, key: 'crown', label: 'Crown' },
  { tier: 4, key: 'king', label: 'King' },
] as const;
export const MAX_VIP_TIER = 4;
export type VipTierKey = (typeof VIP_TIERS)[number]['key'];

export function vipTierLabel(tier: number): string | null {
  return VIP_TIERS.find((t) => t.tier === tier)?.label ?? null;
}

export function vipTierByKey(key: string): number | null {
  return VIP_TIERS.find((t) => t.key === key)?.tier ?? null;
}

/**
 * How a tier badge's MP4 is composited: `normal` is opaque, `additive` keys black to
 * transparent (for clips exported on a black background).
 */
export const BADGE_BLEND_MODES = ['normal', 'additive'] as const;
export type BadgeBlendMode = (typeof BADGE_BLEND_MODES)[number];

export const ROOM_TYPES = ['video', 'audio'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ROOM_STATUSES = ['live', 'ended'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/**
 * Diamonds are the only user currency: bought, spent on gifts and purchases, earned from gifts
 * received, and withdrawn. `agent_stock` is an agent's resale inventory, not spendable.
 */
export const CURRENCIES = ['diamonds', 'agent_stock'] as const;
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
  /** AsadSoft loss cashback and wager rebate credits. */
  'game_cashback',
  /** A claw-back of an unsettled game win (or of a game-wallet withdrawal). */
  'game_reversal',
  /** AsadSoft transfer wallet: diamonds moved into / back out of the game wallet. */
  'game_wallet_deposit',
  'game_wallet_withdraw',
  'withdrawal_hold',
  'withdrawal_release',
  'admin_adjustment',
  // One-off: a legacy bean balance folded into diamonds (2026-11 single-currency migration).
  'currency_merge',
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

/** `live` = a round is being scored; `paused` = between rounds, waiting for a host to start the next. */
export const PK_ROUND_STATES = ['live', 'paused'] as const;
export type PkRoundState = (typeof PK_ROUND_STATES)[number];

export const PK_END_REASONS = [
  'completed',
  'timeout',
  'host_ended',
  'host_left',
  'admin',
  'forfeit',
] as const;
export type PkEndReason = (typeof PK_END_REASONS)[number];

/** Most people on a video stage (host included). The configurable seat count is capped by this. */
export const MAX_VIDEO_SEATS = 13;

/**
 * AsadSoft game ids: lowercase letters, digits and dashes (their `Game.gameId` rule).
 * Games come from the provider's catalogue, so there is no fixed list here.
 */
export const GAME_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * What one AsadSoft wallet call was, derived from its `txId` prefix. Stats and the admin
 * transaction list are keyed on it.
 */
export const GAME_TX_KINDS = [
  'stake',
  'win',
  'refund',
  'cashback',
  'rebate',
  'reversal',
  'transfer_in',
  'transfer_out',
  'other_debit',
  'other_credit',
] as const;
export type GameTxKind = (typeof GAME_TX_KINDS)[number];

export const GAME_TX_STATUSES = ['applied', 'reversed', 'rejected', 'tombstone'] as const;
export type GameTxStatus = (typeof GAME_TX_STATUSES)[number];

/** Why a player can't open a game (or a game is shown locked). */
export const GAME_LOCK_REASONS = ['disabled', 'level', 'blocked', 'live_off'] as const;
export type GameLockReason = (typeof GAME_LOCK_REASONS)[number];

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

/** Formats an avatar frame may use. The app's `FrameView` draws nothing for MP4. */
export const FRAME_FORMATS = [
  'none',
  'svga',
  'lottie',
] as const satisfies readonly AnimationFormat[];

/**
 * Cosmetic types a user can wear. A room background is shown behind the stage of the wearer's
 * own live rooms (a background the host sets for one live still wins).
 */
export const EQUIPPABLE_COSMETIC_TYPES = ['frame', 'entry_animation', 'room_background'] as const;
export type EquippableCosmeticType = (typeof EQUIPPABLE_COSMETIC_TYPES)[number];

/**
 * Types the app's store and wardrobe show. `chat_bubble` exists in the data but has no
 * design yet, so it is neither sold nor listed and the admin can't create new ones.
 */
export const STORE_COSMETIC_TYPES = EQUIPPABLE_COSMETIC_TYPES;

/** Most decorations one bulk-create request may carry. Larger uploads are chunked. */
export const MAX_COSMETICS_PER_BATCH = 100;
/** Longest an admin may grant a tier package or a decoration for, in days. */
export const MAX_GRANT_DAYS = 3650;

/**
 * Media the admin dashboard may upload, by MIME type. `format` is the
 * {@link AnimationFormat} a file of that type plays as. SVGA has no registered MIME type,
 * so it travels as `application/octet-stream`, the only binary type accepted here.
 */
export const MEDIA_TYPES = {
  'image/png': { ext: 'png', format: 'none' },
  'image/webp': { ext: 'webp', format: 'none' },
  'image/jpeg': { ext: 'jpg', format: 'none' },
  'image/gif': { ext: 'gif', format: 'none' },
  'application/octet-stream': { ext: 'svga', format: 'svga' },
  'application/json': { ext: 'json', format: 'lottie' },
  'video/mp4': { ext: 'mp4', format: 'mp4' },
} as const satisfies Record<string, { ext: string; format: AnimationFormat }>;
export type MediaType = keyof typeof MEDIA_TYPES;

/** File extension → MIME type, for files the browser reports no type for (`.svga`). */
export const MEDIA_EXTENSIONS: Record<string, MediaType> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svga: 'application/octet-stream',
  json: 'application/json',
  mp4: 'video/mp4',
};

const MB = 1024 * 1024;
const IMAGES = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'] as const;
const ANIMATIONS = ['application/octet-stream', 'application/json', 'video/mp4'] as const;

/**
 * What each admin upload slot accepts. The dashboard checks these before uploading and the
 * API enforces them when presigning; the signed `Content-Length` makes the size binding.
 */
export const ADMIN_UPLOAD_KINDS = {
  'gift-icon': { types: IMAGES, maxBytes: 2 * MB },
  'gift-animation': { types: ANIMATIONS, maxBytes: 20 * MB },
  // A tier package badge: one slot each for the image, SVGA and MP4 renditions.
  'tier-badge': {
    types: [...IMAGES, 'application/octet-stream', 'video/mp4'],
    maxBytes: 20 * MB,
  },
  'cosmetic-asset': { types: [...IMAGES, ...ANIMATIONS], maxBytes: 20 * MB },
  'cosmetic-preview': { types: IMAGES, maxBytes: 2 * MB },
  'level-icon': { types: IMAGES, maxBytes: 2 * MB },
  'game-icon': { types: IMAGES, maxBytes: 2 * MB },
  'agency-logo': { types: IMAGES, maxBytes: 2 * MB },
  banner: { types: ['image/png', 'image/webp', 'image/jpeg'], maxBytes: 5 * MB },
  // FCM shows only JPEG/PNG reliably on both platforms, and caps notification images at 1 MB.
  announcement: { types: ['image/png', 'image/jpeg'], maxBytes: 1 * MB },
} as const satisfies Record<string, { types: readonly MediaType[]; maxBytes: number }>;
export type AdminUploadKind = keyof typeof ADMIN_UPLOAD_KINDS;
export const ADMIN_UPLOAD_KIND_NAMES = Object.keys(ADMIN_UPLOAD_KINDS) as [
  AdminUploadKind,
  ...AdminUploadKind[],
];

/** Roles inside a host agency. The owner is `agencies.ownerId`, never a member row. */
export const AGENCY_ROLES = ['host', 'admin'] as const;
export type AgencyRole = (typeof AGENCY_ROLES)[number];

export const AGENCY_AUDIT_ACTIONS = [
  'agency_created',
  'agency_updated',
  'agency_suspended',
  'agency_reactivated',
  'host_invited',
  'invite_cancelled',
  'invite_accepted',
  'invite_declined',
  'request_submitted',
  'request_approved',
  'request_rejected',
  'host_added',
  'host_removed',
  'host_left',
  'host_locked',
  'host_unlocked',
  'admin_promoted',
  'admin_demoted',
  'target_updated',
] as const;
export type AgencyAuditAction = (typeof AGENCY_AUDIT_ACTIONS)[number];

export const MESSAGE_TYPES = ['text', 'image', 'gift', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * Socket.IO namespaces and event names. Keep client and server in lock-step through this file.
 * The app namespace carries everything personal (chat, notifications, wallet) plus the live
 * room directory.
 */
export const SOCKET = {
  namespaces: { app: '/' },
  app: {
    /** Client → server: receive live-room directory updates. */
    subscribeRooms: 'rooms:subscribe',
    unsubscribeRooms: 'rooms:unsubscribe',
    roomUpserted: 'rooms:upserted',
    roomEnded: 'rooms:ended',
    chatMessage: 'chat:message',
    chatRead: 'chat:read',
    /** A message moderation removed for both sides: `{ conversationId, messageId }`. */
    chatMessageRemoved: 'chat:message_removed',
    /** Client → server and relayed to the peer. */
    chatTyping: 'chat:typing',
    notification: 'notification:new',
    walletUpdated: 'wallet:updated',
    /**
     * A gift worth at least `live.giftBannerMinDiamonds`, announced to every app socket
     * (shown as a banner in live rooms): `GiftAnnouncement`.
     */
    giftAnnouncement: 'gift:announcement',
  },
} as const;

/**
 * Share links: `https://<LINK_HOST>/<prefix>/<id>`. link-web renders their preview pages and
 * serves the `.well-known` files that let the app claim these paths; the backend's
 * `/v1/share/preview/:kind/:id` describes the target; the app opens `appRoute`. Adding a
 * kind: an entry here, a preview in `modules/share`, a `DeepLink` in the app and its
 * Android manifest prefix (app/test/deep_link_test.dart checks the prefixes match).
 */
export const DEEP_LINK_ROUTES = [
  { kind: 'live', prefix: 'live', id: /^[a-f0-9]{24}$/, appRoute: '/live/:id' },
  { kind: 'user', prefix: 'u', id: SHORT_ID_PATTERN, appRoute: '/u/:id' },
  { kind: 'post', prefix: 'post', id: /^[a-f0-9]{24}$/, appRoute: '/post/:id' },
] as const;
export type DeepLinkKind = (typeof DEEP_LINK_ROUTES)[number]['kind'];

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
  pkRoundEnded: 'bb.pk.round_ended',
  pkRoundStarted: 'bb.pk.round_started',
  reaction: 'bb.reaction',
  entry: 'bb.entry',
  roomEnded: 'bb.room.ended',
  /** Full snapshot of a live's YouTube music (`YouTubeState`), ordered by its `rev`. */
  youtube: 'bb.youtube',
} as const;

/** Songs a live's YouTube queue holds; keeps the snapshot packet small. */
export const YT_QUEUE_MAX = 30;
