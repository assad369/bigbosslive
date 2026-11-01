import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Image } from 'antd';
import { FileOutlined } from '@ant-design/icons';
import type { AnimationFormat } from '@bigboss/shared';
import type { Player as SvgaPlayer } from 'svgaplayerweb';
import type { AnimationItem } from 'lottie-web';
import { formatOf } from '../lib/decorations';
import { brand } from '../theme';

/** True while the element is on screen, so off-screen rows don't keep animations running. */
function useVisible(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), {
      rootMargin: '64px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

/**
 * Plays any decoration asset the app can show: images, muted MP4, SVGA and Lottie. The SVGA and
 * Lottie players are loaded on first use and only run while the preview is visible.
 */
export function DecorationPreview({
  url,
  format,
  size = 48,
  style,
}: {
  url: string;
  format?: AnimationFormat | null;
  size?: number;
  style?: CSSProperties;
}) {
  const f = formatOf(url, format);
  const box: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 8,
    flex: 'none',
    overflow: 'hidden',
    background: brand.palette.ivory,
    border: `1px solid ${brand.palette.border}`,
    ...style,
  };
  if (f === 'none')
    return (
      <Image
        src={url}
        width={size}
        height={size}
        style={{ ...box, objectFit: 'contain' }}
        fallback="data:image/gif;base64,R0lGODlhAQABAAAAACw="
      />
    );
  if (f === 'mp4')
    return (
      <video src={url} muted loop autoPlay playsInline style={{ ...box, objectFit: 'contain' }} />
    );
  return f === 'svga' ? (
    <SvgaView url={url} size={size} box={box} />
  ) : (
    <LottieView url={url} size={size} box={box} />
  );
}

function Fallback({ label, size, box }: { label: string; size: number; box: CSSProperties }) {
  return (
    <div
      style={{ ...box, display: 'grid', placeItems: 'center', color: brand.palette.bronze }}
      title={`${label} animation (could not be played here)`}
    >
      <div style={{ textAlign: 'center', fontSize: size > 40 ? 11 : 9, fontWeight: 700 }}>
        <FileOutlined style={{ fontSize: size > 40 ? 20 : 14 }} />
        {size > 40 && <div>{label}</div>}
      </div>
    </div>
  );
}

function SvgaView({ url, size, box }: { url: string; size: number; box: CSSProperties }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const visible = useVisible(canvas);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible || !canvas.current) return;
    const el = canvas.current;
    let cancelled = false;
    let player: SvgaPlayer | null = null;
    import('svgaplayerweb')
      .then((mod) => {
        // A UMD bundle: the classes sit on `default` or on the module itself.
        const lib = (mod.default ?? mod) as Pick<typeof mod, 'Player' | 'Parser'>;
        if (cancelled) return;
        player = new lib.Player(el);
        player.setContentMode('AspectFit');
        new lib.Parser().load(
          url,
          (video) => {
            if (cancelled || !player) return;
            player.setVideoItem(video);
            player.startAnimation();
          },
          () => !cancelled && setFailed(true),
        );
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      player?.stopAnimation(true);
    };
  }, [url, visible]);

  if (failed) return <Fallback label="SVGA" size={size} box={box} />;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return <canvas ref={canvas} width={size * dpr} height={size * dpr} style={box} />;
}

function LottieView({ url, size, box }: { url: string; size: number; box: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null);
  const visible = useVisible(host);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible || !host.current) return;
    const el = host.current;
    let cancelled = false;
    let anim: AnimationItem | null = null;
    import('lottie-web')
      .then(({ default: lottie }) => {
        if (cancelled) return;
        anim = lottie.loadAnimation({
          container: el,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          path: url,
        });
        anim.addEventListener('data_failed', () => !cancelled && setFailed(true));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [url, visible]);

  if (failed) return <Fallback label="LOTTIE" size={size} box={box} />;
  return <div ref={host} style={box} />;
}
