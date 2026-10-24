import type { ThemeConfig } from 'antd';
import { gradients, palette, typography } from '@bigboss/shared';

/**
 * Ant Design theme built from the shared Champagne tokens. Light ivory layout, white cards,
 * deep-gold primary, bronze accents, and a dark espresso sider with gold highlights.
 */
export const theme: ThemeConfig = {
  cssVar: { prefix: 'bb' },
  token: {
    colorPrimary: palette.goldDeep,
    colorInfo: palette.info,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.danger,
    colorLink: palette.bronze,
    colorTextBase: palette.ink,
    colorBgLayout: palette.ivory,
    colorBgContainer: palette.surface,
    colorBorder: palette.border,
    colorBorderSecondary: '#F1E8D6',
    colorFillAlter: palette.surfaceMuted,
    fontFamily: typography.body,
    borderRadius: 10,
    borderRadiusLG: 14,
    controlHeight: 36,
    boxShadowTertiary: '0 1px 2px rgba(43,33,24,0.06), 0 2px 8px rgba(43,33,24,0.04)',
  },
  components: {
    Layout: {
      siderBg: palette.ink,
      headerBg: palette.surface,
      headerHeight: 64,
      headerPadding: '0 24px',
    },
    Menu: {
      darkItemBg: palette.ink,
      darkSubMenuItemBg: '#231a12',
      darkItemColor: '#D9CBB0',
      darkItemHoverColor: palette.goldLight,
      darkItemSelectedBg: 'rgba(201,162,39,0.18)',
      darkItemSelectedColor: palette.goldLight,
      darkGroupTitleColor: palette.inkSubtle,
      itemBorderRadius: 8,
    },
    Card: { headerFontSize: 15 },
    Table: {
      headerBg: palette.surfaceMuted,
      headerColor: palette.inkMuted,
      rowHoverBg: '#FDF9F0',
    },
    Button: { primaryShadow: '0 2px 6px rgba(184,134,11,0.25)', fontWeight: 500 },
    Tag: { defaultBg: palette.surfaceMuted },
    Statistic: { titleFontSize: 13 },
  },
};

export const brand = { palette, gradients, typography };
