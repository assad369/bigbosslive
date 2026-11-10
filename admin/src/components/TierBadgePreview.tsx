import { CrownOutlined } from '@ant-design/icons';
import type { TierBadge } from '@bigboss/shared';
import { badgeSource } from '../lib/tiers';
import { brand } from '../theme';
import { DecorationPreview } from './DecorationPreview';

/** A tier badge as the app shows it: round, playing its best rendition. */
export function TierBadgePreview({ badge, size = 44 }: { badge: TierBadge | null; size?: number }) {
  const src = badgeSource(badge);
  if (!src)
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: `1px dashed ${brand.palette.vip}`,
          display: 'grid',
          placeItems: 'center',
          color: brand.palette.vip,
          flex: 'none',
        }}
      >
        <CrownOutlined />
      </div>
    );
  return (
    <DecorationPreview
      url={src.url}
      format={src.format}
      size={size}
      style={{
        borderRadius: '50%',
        mixBlendMode:
          src.format === 'mp4' && badge?.blendMode === 'additive' ? 'screen' : undefined,
      }}
    />
  );
}
