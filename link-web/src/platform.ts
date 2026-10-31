export type Platform = 'android' | 'ios' | 'other';

/**
 * Coarse platform from the User-Agent, only used to pick the call-to-action buttons. iPadOS
 * reports a desktop Mac UA; it lands in `other`, which still shows the App Store button, and
 * Safari shows the Smart App Banner there.
 */
export function detectPlatform(ua: string | undefined): Platform {
  if (!ua) return 'other';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'other';
}
