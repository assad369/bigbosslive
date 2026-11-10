import type { TierBadge } from '@bigboss/shared';
import { brand } from '../theme';

/** Tier colours (VIP purple, VVIP gold, Crown rose, King crimson), from the shared palette. */
export const VIP_COLORS: Record<number, string> = {
  1: brand.palette.vip,
  2: brand.palette.vvipDeep,
  3: brand.palette.crownDeep,
  4: brand.palette.king,
};

/** The stored tier outlives its expiry until the hourly sweep; only an unexpired one counts. */
export const activeTierOf = (vip: { tier: number; expiresAt: string | null }) =>
  vip.tier > 0 && (!vip.expiresAt || new Date(vip.expiresAt) > new Date()) ? vip.tier : 0;

/** The rendition the app plays: MP4, else SVGA, else the image. */
export function badgeSource(b: TierBadge | null | undefined) {
  if (b?.mp4Url) return { url: b.mp4Url, format: 'mp4' as const };
  if (b?.svgaUrl) return { url: b.svgaUrl, format: 'svga' as const };
  if (b?.imageUrl) return { url: b.imageUrl, format: 'none' as const };
  return null;
}
