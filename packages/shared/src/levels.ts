/** Highest level the ladder may have (`level_configs` rows 1…MAX_LEVEL). */
export const MAX_LEVEL = 500;

/**
 * One band of the default ladder: levels (previous band's `toLevel` + 1) … `toLevel`, each
 * needing `pointsPerLevel` more level points than the one before. Thresholds are cumulative.
 */
export interface LevelTierBand {
  name: string;
  toLevel: number;
  pointsPerLevel: number;
  color: string;
}

/** The default 500-level ladder (the same bands as bdlive_pro). */
export const DEFAULT_LEVEL_TIERS: readonly LevelTierBand[] = [
  { name: 'Bronze', toLevel: 10, pointsPerLevel: 100_000, color: '#CD7F32' },
  { name: 'Silver', toLevel: 15, pointsPerLevel: 500_000, color: '#9EA7B3' },
  { name: 'Gold', toLevel: 20, pointsPerLevel: 100_000_000, color: '#E6B422' },
  { name: 'Diamond', toLevel: 30, pointsPerLevel: 200_000_000, color: '#14B8A6' },
  { name: 'Crown', toLevel: 50, pointsPerLevel: 200_000_000, color: '#3B82F6' },
  { name: 'Star', toLevel: 100, pointsPerLevel: 200_000_000, color: '#8B5CF6' },
  { name: 'Legend', toLevel: 200, pointsPerLevel: 200_000_000, color: '#EC4899' },
  { name: 'Mythic', toLevel: 350, pointsPerLevel: 200_000_000, color: '#F97316' },
  { name: 'Supreme', toLevel: MAX_LEVEL, pointsPerLevel: 200_000_000, color: '#EF4444' },
];

export interface DefaultLevel {
  level: number;
  pointsRequired: number;
  name: string;
  color: string;
  iconUrl: null;
}

/** Expands {@link DEFAULT_LEVEL_TIERS} into one row per level (the `PUT /admin/levels` shape). */
export function buildDefaultLevels(
  tiers: readonly LevelTierBand[] = DEFAULT_LEVEL_TIERS,
): DefaultLevel[] {
  const rows: DefaultLevel[] = [];
  let points = 0;
  for (const t of tiers) {
    for (let level = rows.length + 1; level <= t.toLevel; level++) {
      points += t.pointsPerLevel;
      rows.push({ level, pointsRequired: points, name: t.name, color: t.color, iconUrl: null });
    }
  }
  return rows;
}
