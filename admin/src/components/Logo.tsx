/** Crown mark in metallic gold on an espresso tile. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="bb-logo-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E9CF7A" />
          <stop offset=".45" stopColor="#C9A227" />
          <stop offset="1" stopColor="#B8860B" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#2B2118" />
      <path d="M12 44 L16 22 L26 32 L32 16 L38 32 L48 22 L52 44 Z" fill="url(#bb-logo-gold)" />
      <rect x="12" y="46" width="40" height="5" rx="2" fill="url(#bb-logo-gold)" />
    </svg>
  );
}
