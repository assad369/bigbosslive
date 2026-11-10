import { Grid } from 'antd';

/**
 * True below antd's `md` breakpoint (768px): phones and small tablets in portrait.
 * The one switch pages use to adapt; layout-wide CSS lives in `styles.css`.
 * The navigation shell collapses earlier, below `lg` (`AdminLayout`).
 */
export function useIsMobile(): boolean {
  const screens = Grid.useBreakpoint();
  // Before the first measurement every key is undefined: assume desktop, as the shell does.
  return screens.md === false;
}
