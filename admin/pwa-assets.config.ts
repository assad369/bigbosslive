// Generates the PWA icons from the crown favicon. Run `npm run pwa-assets -w admin` after
// changing `public/favicon.svg`, and commit the PNGs it writes to `public/`.
// The generator runs through npx (pinned in package.json) so CI and Docker never install
// sharp, which is why this file imports nothing: it spells out the "minimal 2023" preset.
// The espresso background (palette.ink) fills the corners of the rounded tile, so the
// maskable and Apple icons read as one full-bleed square.
const ink = '#2B2118';

export default {
  headLinkOptions: { preset: '2023' },
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']] },
    maskable: { sizes: [512], padding: 0.2, resizeOptions: { background: ink } },
    apple: { sizes: [180], padding: 0.15, resizeOptions: { background: ink } },
  },
  images: ['public/favicon.svg'],
};
