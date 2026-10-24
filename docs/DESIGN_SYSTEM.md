# Design system: "Champagne"

BigBoss Live is a **light, warm** brand: ivory surfaces, deep gold as the brand colour, and
bronze as the secondary colour. Immersive surfaces (live rooms, games) sit on a warm espresso
base so video and gold effects glow.

Sources of truth, kept identical:
- `packages/shared/src/theme.ts` (admin dashboard, games)
- `app/lib/core/theme/bb_colors.dart` (Flutter)

## Palette

| Token | Hex | Use |
|---|---|---|
| ivory | `#FBF7EF` | App / layout background |
| surface | `#FFFFFF` | Cards, sheets |
| surfaceMuted | `#F6EFE1` | Table headers, inputs, chips |
| champagne | `#F3E5C3` | Selected states, icon tiles, avatar fallback |
| champagneDeep | `#E8D3A2` | Secondary chart series, outlines on gold |
| gold | `#C9A227` | Highlights, focus rings, progress |
| goldDeep | `#B8860B` | **Primary**: buttons, active nav, links on light backgrounds |
| goldLight | `#E9CF7A` | Gold text on dark, gradient start |
| bronze | `#8C6239` | Secondary actions, icons |
| bronzeDeep | `#6B4826` | Text on gold surfaces |
| ink | `#2B2118` | Primary text, the admin sidebar, the logo tile |
| inkMuted / inkSubtle | `#6E5E4B` / `#A3927C` | Secondary / tertiary text |
| border | `#EADFC8` | Hairlines |
| success / warning / danger / info | `#3F8F5A` / `#D08A1E` / `#B4443A` / `#3C6E8F` | Status |
| espresso | `#1D1610` | Live rooms, games, gift panel |

**Gradients**
- *Gold* (`goldLight → gold → goldDeep`, 135°): the primary CTA, hero stat, VIP tiers, chips.
- *Champagne* (`surface → champagne`): headers and hero areas.
- *Bronze*: secondary tiers and badges.
- *Video scrim* (espresso, bottom-up): keeps overlay text readable on video.

## Typography

- **Playfair Display** (700): display and headline styles, the wordmark, page titles.
- **Manrope / Inter**: all UI text. Use tabular figures for money and counters.

## Rules

1. Never inline a hex value at a call site. Add or reuse a token.
2. Gold carries brand and premium meaning. Use it for primary actions, VIP, levels and
   rewards, not for every border.
3. On gold surfaces, text is `ink` or `bronzeDeep`, never white.
4. On espresso surfaces, text is `ivory` and `champagne`, and accents are `goldLight`.
5. Money always shows its unit: 💎 for diamonds, 🫘 for beans, `$` for payouts.
6. Level badges use the tier gradient: bronze (1–19), silver (20–39), gold (40–69), dark gold
   (70+).
