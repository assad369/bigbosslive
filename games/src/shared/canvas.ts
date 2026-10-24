/** A HiDPI canvas filling its parent, with a resize-aware draw loop. */
export function mountCanvas(
  parent: HTMLElement,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void,
) {
  const canvas = document.createElement('canvas');
  parent.prepend(canvas);
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = parent.clientWidth;
    h = parent.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  new ResizeObserver(resize).observe(parent);
  resize();
  const frame = (t: number) => {
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h, t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return canvas;
}

export const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeOutQuint = (x: number) => 1 - Math.pow(1 - x, 5);

export const GOLD = {
  light: '#E9CF7A',
  mid: '#C9A227',
  deep: '#B8860B',
  ivory: '#FBF7EF',
  ink: '#2B2118',
  bronze: '#8C6239',
};
