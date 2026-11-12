/**
 * Plain-language catalogue for audit log entries: what each action key means, how serious it
 * is, and the one-line fact worth showing from its payload. Unknown keys fall back to a
 * humanized form of the key, so a new action never renders blank.
 */
import { brand } from '../theme';
import { dateTime, num } from './format';

export type AuditTone = 'danger' | 'warning' | 'success' | 'info' | 'neutral';
type Payload = Record<string, unknown>;

export const TONE_COLORS: Record<AuditTone, string> = {
  danger: brand.palette.danger,
  warning: brand.palette.warning,
  success: brand.palette.success,
  info: brand.palette.info,
  neutral: brand.palette.bronze,
};

/** Domains are action prefixes (`wallet` covers `wallet.*`), the unit of the domain filter. */
export const AUDIT_DOMAINS = {
  user: 'Users',
  admin: 'Staff accounts',
  wallet: 'Wallets',
  withdrawal: 'Withdrawals',
  moderator: 'Platform moderators',
  device: 'Devices',
  report: 'Reports',
  feed: 'Feed posts',
  live: 'Live rooms',
  youtube: 'YouTube music',
  pk: 'PK battles',
  gift: 'Gifts',
  recharge_package: 'Recharge packages',
  tier_package: 'Tier packages',
  cosmetic: 'Decorations',
  levels: 'Levels',
  agency: 'Agencies',
  game: 'Games',
  banner: 'Banners',
  announcement: 'Announcements',
  config: 'Settings',
  maintenance: 'Maintenance',
  storage: 'Storage',
  sightguard: 'Automated moderation',
} as const;
export type AuditDomain = keyof typeof AUDIT_DOMAINS;

interface ActionSpec {
  label: string;
  tone?: AuditTone;
  /** A short fact from the payload ("−500 diamonds · refund"); null when there is none. */
  summary?: (p: Payload) => string | null;
  /** Payload-dependent wording, e.g. a toggle recorded under one key. */
  variant?: (p: Payload) => { label?: string; tone?: AuditTone } | null;
}

// ── Payload readers (payloads are untyped JSON) ────────────────────────────────

const str = (p: Payload, k: string) => {
  const v = p[k];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
const int = (p: Payload, k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
const list = (p: Payload, k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]) : null);
const join = (...parts: (string | number | null | undefined | false)[]) =>
  parts.filter(Boolean).join(' · ') || null;
const quote = (s: string | null) => (s ? `“${truncate(s, 80)}”` : null);
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n))}`;
const nameOf = (p: Payload) => str(p, 'name') ?? str(p, 'title') ?? str(p, 'label');
const banLength = (p: Payload) => {
  const days = int(p, 'days');
  return days ? plural(days, 'day') : 'Until lifted';
};
/** "Changed display name, bio" from a patch body. */
const changed = (p: Payload) => {
  const keys = Object.keys(p);
  if (!keys.length) return null;
  const shown = keys.slice(0, 4).map((k) => humanizeKey(k).toLowerCase());
  return `Changed ${shown.join(', ')}${keys.length > 4 ? ` and ${keys.length - 4} more` : ''}`;
};
const named = (p: Payload) => nameOf(p);
const reason = (p: Payload) => quote(str(p, 'reason'));

export const AUDIT_ACTIONS: Record<string, ActionSpec> = {
  // Users
  'user.edit': { label: 'Edited profile', summary: changed },
  'user.ban': {
    label: 'Banned user',
    tone: 'danger',
    summary: (p) => join(banLength(p), reason(p)),
  },
  'user.unban': { label: 'Lifted user ban', tone: 'success' },
  'user.short_id': {
    label: 'Changed public ID',
    summary: (p) => (str(p, 'shortId') ? `New ID ${str(p, 'shortId')}` : null),
  },
  'user.platform_moderator': {
    label: 'Changed platform moderator role',
    variant: (p) =>
      p.enabled === true
        ? { label: 'Made platform moderator', tone: 'warning' }
        : p.enabled === false
          ? { label: 'Removed platform moderator', tone: 'warning' }
          : null,
  },
  'user.agent': {
    label: 'Changed agent status',
    variant: (p) =>
      p.isAgent === true
        ? { label: 'Made recharge agent', tone: 'warning' }
        : p.isAgent === false
          ? { label: 'Removed recharge agent', tone: 'warning' }
          : null,
  },
  'user.tier_package.grant': {
    label: 'Granted tier package',
    tone: 'success',
    summary: (p) =>
      join(named(p), int(p, 'durationDays') && plural(int(p, 'durationDays')!, 'day')),
  },
  'user.tier_package.revoke': { label: 'Revoked tier package', tone: 'danger' },
  'user.cosmetic.grant': {
    label: 'Granted decoration',
    tone: 'success',
    summary: (p) => join(named(p), int(p, 'days') && plural(int(p, 'days')!, 'day')),
  },
  'user.cosmetic.revoke': { label: 'Revoked decoration', tone: 'danger' },

  // Staff
  'admin.role': {
    label: 'Changed staff role',
    tone: 'warning',
    summary: (p) =>
      p.role === null
        ? 'Dashboard access removed'
        : str(p, 'role') && `Role → ${roleLabel(str(p, 'role')!)}`,
  },
  'admin.password_reset': { label: 'Reset staff password', tone: 'warning' },

  // Money
  'wallet.adjust': {
    label: 'Adjusted wallet balance',
    tone: 'warning',
    summary: (p) =>
      join(
        int(p, 'delta') !== null && `${signed(int(p, 'delta')!)} diamonds`,
        quote(str(p, 'note')),
      ),
  },
  'wallet.recharge': {
    label: 'Recharged wallet',
    tone: 'success',
    summary: (p) =>
      join(
        int(p, 'diamonds') !== null && `+${num(int(p, 'diamonds'))} diamonds`,
        quote(str(p, 'note')),
      ),
  },
  'withdrawal.approve': {
    label: 'Approved withdrawal',
    tone: 'success',
    summary: (p) => quote(str(p, 'note')),
  },
  'withdrawal.reject': {
    label: 'Rejected withdrawal',
    tone: 'danger',
    summary: (p) => quote(str(p, 'note')),
  },
  'withdrawal.mark_paid': {
    label: 'Marked withdrawal as paid',
    tone: 'success',
    summary: (p) => quote(str(p, 'note')),
  },

  // Moderation
  'moderator.user_ban': {
    label: 'Banned user',
    tone: 'danger',
    summary: (p) => join(banLength(p), reason(p), p.banDevices === true && 'devices too'),
  },
  'moderator.user_unban': { label: 'Lifted user ban', tone: 'success' },
  'moderator.device_ban': {
    label: 'Banned device',
    tone: 'danger',
    summary: (p) => join(reason(p), deviceSummary(p)),
  },
  'moderator.room_unban': { label: 'Lifted a host’s room ban', tone: 'success' },
  'device.ban': {
    label: 'Banned device',
    tone: 'danger',
    summary: (p) => join(reason(p), deviceSummary(p)),
  },
  'device.unban': { label: 'Unbanned device', tone: 'success' },
  'report.resolve': {
    label: 'Resolved report',
    variant: (p) =>
      p.status === 'dismissed'
        ? { label: 'Dismissed report', tone: 'neutral' }
        : { tone: 'success' },
    summary: (p) => join(str(p, 'action') && humanizeKey(str(p, 'action')!), quote(str(p, 'note'))),
  },
  'feed.status': {
    label: 'Changed post status',
    tone: 'warning',
    summary: (p) =>
      str(p, 'status') ? `Now ${humanizeKey(str(p, 'status')!).toLowerCase()}` : null,
  },

  // Live
  'live.end': {
    label: 'Ended live',
    tone: 'danger',
    summary: (p) => (str(p, 'by') ? `By ${str(p, 'by')}` : null),
  },
  'live.kick': {
    label: 'Removed viewer from live',
    tone: 'danger',
    summary: (p) =>
      int(p, 'banMinutes')
        ? `Banned from the room for ${plural(int(p, 'banMinutes')!, 'minute')}`
        : null,
  },
  'live.chat_delete': { label: 'Deleted chat message', tone: 'danger' },
  'live.seat_decide': {
    label: 'Answered seat request',
    variant: (p) =>
      p.accept === true
        ? { label: 'Accepted seat request', tone: 'success' }
        : p.accept === false
          ? { label: 'Declined seat request', tone: 'neutral' }
          : null,
  },
  'live.seat_invite': { label: 'Invited to a seat' },
  'live.seat_manage': {
    label: 'Managed a seat',
    summary: (p) =>
      join(
        int(p, 'index') !== null && `Seat ${int(p, 'index')! + 1}`,
        str(p, 'action') && humanizeKey(str(p, 'action')!),
      ),
  },
  'live.stage_swap': {
    label: 'Swapped host spot',
    summary: (p) => (p.userId === null ? 'Restored the host' : null),
  },
  'live.platform_moderator_stage': {
    label: 'Moderator stage change',
    variant: (p) =>
      p.onStage === true
        ? { label: 'Moderator took a seat' }
        : { label: 'Moderator left the stage' },
  },
  'pk.end': { label: 'Ended PK battle', tone: 'danger' },
  'youtube.play': { label: 'Played a song' },
  'youtube.enqueue': { label: 'Queued a song' },
  'youtube.playQueued': { label: 'Played a queued song' },
  'youtube.pause': { label: 'Paused music' },
  'youtube.resume': { label: 'Resumed music' },
  'youtube.seek': { label: 'Seeked music' },
  'youtube.next': { label: 'Skipped to next song' },
  'youtube.stop': { label: 'Stopped music', tone: 'danger' },
  'youtube.remove': { label: 'Removed queued song' },
  'youtube.move': { label: 'Reordered queue' },
  'youtube.clearQueue': { label: 'Cleared song queue', tone: 'danger' },

  // Catalogue
  'gift.create': { label: 'Created gift', tone: 'success', summary: named },
  'gift.update': { label: 'Edited gift', summary: (p) => named(p) ?? changed(p) },
  'recharge_package.create': {
    label: 'Created recharge package',
    tone: 'success',
    summary: (p) => named(p) ?? (int(p, 'diamonds') ? `${num(int(p, 'diamonds'))} diamonds` : null),
  },
  'recharge_package.update': {
    label: 'Edited recharge package',
    summary: (p) => named(p) ?? (int(p, 'diamonds') ? `${num(int(p, 'diamonds'))} diamonds` : null),
  },
  'tier_package.create': { label: 'Created tier package', tone: 'success', summary: named },
  'tier_package.update': { label: 'Edited tier package', summary: (p) => named(p) ?? changed(p) },
  'tier_package.delete': { label: 'Deleted tier package', tone: 'danger' },
  'cosmetic.create': { label: 'Created decoration', tone: 'success', summary: named },
  'cosmetic.bulk_create': {
    label: 'Imported decorations',
    tone: 'success',
    summary: (p) => (int(p, 'count') !== null ? plural(int(p, 'count')!, 'decoration') : null),
  },
  'cosmetic.update': { label: 'Edited decoration', summary: (p) => named(p) ?? changed(p) },
  'cosmetic.delete': { label: 'Deleted decoration', tone: 'danger' },
  'levels.replace': {
    label: 'Replaced level table',
    tone: 'warning',
    summary: (p) => (int(p, 'count') !== null ? plural(int(p, 'count')!, 'level') : null),
  },
  'levels.relevel': {
    label: 'Recalculated user levels',
    tone: 'warning',
    summary: (p) => {
      const n = int(p, 'updated');
      return n !== null ? `${plural(n, 'user')} updated of ${num(int(p, 'scanned') ?? n)}` : null;
    },
  },

  // Agencies
  'agency.create': { label: 'Created agency', tone: 'success', summary: named },
  'agency.update': { label: 'Edited agency', summary: (p) => named(p) ?? changed(p) },
  'agency.add_member': { label: 'Added host to agency', tone: 'success' },
  'agency.remove_member': { label: 'Removed host from agency', tone: 'danger' },
  'agency.unlock_member': { label: 'Unlocked agency host', tone: 'warning' },
  'agency.monthly_reset': { label: 'Ran monthly agency reset', tone: 'warning' },

  // Games
  'game.update': { label: 'Edited game', summary: changed },
  'game.config': { label: 'Changed game odds', tone: 'warning' },
  'game.void_round': { label: 'Voided game round', tone: 'danger' },

  // Engagement & settings
  'banner.create': { label: 'Created banner', tone: 'success', summary: named },
  'banner.update': { label: 'Edited banner', summary: named },
  'banner.delete': { label: 'Deleted banner', tone: 'danger' },
  'announcement.create': {
    label: 'Sent announcement',
    tone: 'info',
    summary: (p) =>
      join(
        quote(str(p, 'title')),
        str(p, 'audience') && `to ${humanizeKey(str(p, 'audience')!).toLowerCase()}`,
      ),
  },
  'config.update': { label: 'Changed settings', tone: 'warning', summary: changed },
  'maintenance.access_add': {
    label: 'Gave maintenance access',
    tone: 'warning',
    summary: (p) => {
      const n = list(p, 'added')?.length ?? 0;
      return n ? plural(n, 'user') : null;
    },
  },
  'maintenance.access_remove': { label: 'Removed maintenance access', tone: 'warning' },
  'storage.update': {
    label: 'Changed storage credentials',
    tone: 'danger',
    summary: (p) =>
      join(
        str(p, 'bucket') && `Bucket ${str(p, 'bucket')}`,
        p.secretChanged === true && 'secret rotated',
      ),
  },
  'storage.cors': {
    label: 'Changed storage CORS',
    tone: 'warning',
    summary: (p) => {
      const n = list(p, 'origins')?.length;
      return n !== undefined ? plural(n, 'origin') : null;
    },
  },
  'storage.reset': { label: 'Reset storage to defaults', tone: 'danger' },

  // Automated (SightGuard)
  'sightguard.user.ban': { label: 'Auto-banned user', tone: 'danger', summary: reason },
  'sightguard.live.end': { label: 'Auto-ended live', tone: 'danger', summary: reason },
  'sightguard.live.remove': {
    label: 'Auto-removed from live',
    tone: 'danger',
    summary: (p) =>
      join(
        reason(p),
        int(p, 'banMinutes') && `${plural(int(p, 'banMinutes')!, 'minute')} room ban`,
      ),
  },
  'sightguard.live.mute': {
    label: 'Auto-muted on stage',
    tone: 'danger',
    summary: (p) => join(str(p, 'media') && humanizeKey(str(p, 'media')!), reason(p)),
  },
  'sightguard.content.removed': { label: 'Auto-removed content', tone: 'danger', summary: reason },
};

/** Device bans report the cascade: `bannedUsers` (staff) or `devicesBanned`/`accountsBanned`. */
function deviceSummary(p: Payload): string | null {
  const devices = int(p, 'devicesBanned');
  const accounts =
    int(p, 'accountsBanned') ?? int(p, 'bannedUsers') ?? list(p, 'bannedUsers')?.length;
  return join(
    devices && plural(devices, 'device'),
    accounts && `${plural(accounts, 'account')} banned`,
  );
}

export interface DescribedAction {
  label: string;
  tone: AuditTone;
  summary: string | null;
  domain: string;
  domainLabel: string;
}

/** What an entry says in plain words. Never throws on an unexpected payload. */
export function describeAction(action: string, payload: unknown): DescribedAction {
  const spec = AUDIT_ACTIONS[action];
  const domain = domainOf(action);
  const p: Payload =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
  let summary: string | null = null;
  let variant: ReturnType<NonNullable<ActionSpec['variant']>> = null;
  try {
    summary = spec?.summary?.(p) ?? null;
    variant = spec?.variant?.(p) ?? null;
  } catch {
    // A payload of an older shape only loses its summary line.
  }
  return {
    label: variant?.label ?? spec?.label ?? fallbackLabel(action),
    tone: variant?.tone ?? spec?.tone ?? 'neutral',
    summary,
    domain,
    domainLabel: AUDIT_DOMAINS[domain as AuditDomain] ?? humanizeKey(domain),
  };
}

export const domainOf = (action: string) => action.split('.')[0] ?? action;

/** `user.tier_package.grant` → "Tier package grant". */
export function fallbackLabel(action: string): string {
  const parts = action.split('.');
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  return humanizeKey(rest.join(' '));
}

/** Action filter options, grouped by domain. */
export function actionOptions() {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const [key, spec] of Object.entries(AUDIT_ACTIONS)) {
    const d = domainOf(key);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push({ value: key, label: spec.label });
  }
  return [...groups].map(([d, options]) => ({
    label: AUDIT_DOMAINS[d as AuditDomain] ?? humanizeKey(d),
    title: d,
    options,
  }));
}

// ── Roles and targets ──────────────────────────────────────────────────────────

export const ROLE_META: Record<string, { label: string; color: string }> = {
  superadmin: { label: 'Superadmin', color: brand.palette.umber },
  admin: { label: 'Admin', color: brand.palette.goldDeep },
  finance: { label: 'Finance', color: brand.palette.success },
  moderator: { label: 'Moderator', color: brand.palette.info },
  support: { label: 'Support', color: brand.palette.bronze },
  platform_moderator: { label: 'Platform moderator', color: brand.palette.pkBlue },
  system: { label: 'Automated', color: brand.palette.inkMuted },
  user: { label: 'User', color: brand.palette.inkSubtle },
};
export const roleLabel = (role: string) => ROLE_META[role]?.label ?? humanizeKey(role);

export const TARGET_LABELS: Record<string, string> = {
  user: 'User',
  agency: 'Agency',
  announcement: 'Announcement',
  banner: 'Banner',
  config: 'Setting',
  cosmetic: 'Decoration',
  device: 'Device',
  game: 'Game',
  game_round: 'Game round',
  gift: 'Gift',
  levels: 'Level table',
  live_room: 'Live room',
  room: 'Live room',
  pk: 'PK battle',
  post: 'Feed post',
  recharge_package: 'Recharge package',
  report: 'Report',
  tier_package: 'Tier package',
  withdrawal: 'Withdrawal',
};
export const targetLabel = (type: string) => TARGET_LABELS[type] ?? humanizeKey(type);

// ── Payload view ───────────────────────────────────────────────────────────────

/** `banMinutes` / `ban_minutes` → "Ban minutes"; `isAgent` → "Is agent". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A scalar for the details table; objects and arrays are left to the caller. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string' && ISO_DATE.test(v)) return dateTime(v);
  return String(v);
}

export const isScalar = (v: unknown) => v === null || typeof v !== 'object';
