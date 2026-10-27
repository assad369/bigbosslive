/**
 * BigBoss Live "Champagne" design tokens.
 *
 * Light, warm-ivory surfaces with deep gold as the brand accent and bronze as the
 * secondary. These values are mirrored in the Flutter app (`app/lib/core/theme/bb_colors.dart`)
 * — change both in the same commit.
 */
export const palette = {
  ivory: '#FBF7EF',
  surface: '#FFFFFF',
  surfaceMuted: '#F6EFE1',
  champagne: '#F3E5C3',
  champagneDeep: '#E8D3A2',
  gold: '#C9A227',
  goldDeep: '#B8860B',
  goldLight: '#E9CF7A',
  bronze: '#8C6239',
  bronzeDeep: '#6B4826',
  ink: '#2B2118',
  inkMuted: '#6E5E4B',
  inkSubtle: '#A3927C',
  border: '#EADFC8',
  success: '#3F8F5A',
  warning: '#D08A1E',
  danger: '#B4443A',
  info: '#3C6E8F',
  /** Warm scrim used over live video and game canvases. */
  scrim: 'rgba(43, 33, 24, 0.55)',
  /** Darkens a room background image under the audio seat grid. */
  espressoShade: 'rgba(29, 22, 16, 0.67)',
  goldTint: 'rgba(233, 207, 122, 0.2)',
  goldOutline: 'rgba(233, 207, 122, 0.33)',
  champagneTint: 'rgba(243, 229, 195, 0.13)',
  /** PK sides: the room's own host is always red, the opponent blue. */
  pkRed: '#D64545',
  pkBlue: '#3D7BD9',
  heart: '#E5486B',
} as const;

export const gradients = {
  /** Metallic gold — primary brand gradient (buttons, headers, badges). */
  gold: `linear-gradient(135deg, ${palette.goldLight} 0%, ${palette.gold} 45%, ${palette.goldDeep} 100%)`,
  /** Soft champagne wash for hero areas. */
  champagne: `linear-gradient(180deg, ${palette.surface} 0%, ${palette.champagne} 100%)`,
  /** Bronze for secondary emphasis. */
  bronze: `linear-gradient(135deg, #B07D4F 0%, ${palette.bronze} 60%, ${palette.bronzeDeep} 100%)`,
} as const;

export const typography = {
  display: "'Playfair Display', Georgia, serif",
  body: "'Inter', 'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const;

export const radii = { sm: 6, md: 10, lg: 16, xl: 24, pill: 999 } as const;

export type PaletteKey = keyof typeof palette;
