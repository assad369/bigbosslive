import { palette } from '@bigboss/shared';

/** The espresso the live room sits on (`BBColors.espresso` in the app). */
export const ESPRESSO = '#1D1610';

/** Served at /assets/site.css (the CSP forbids inline styles). The live room's espresso and gold. */
export const SITE_CSS = `
:root{--bg:${ESPRESSO};--surface:#2A2017;--border:${palette.goldOutline};--text:${palette.ivory};--muted:${palette.champagneDeep};--gold:${palette.gold};--gold-light:${palette.goldLight};--gold-deep:${palette.goldDeep};--ink:${palette.ink};--live:${palette.heart}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:24px;color:var(--gold-light);text-decoration:none}
.brand img{width:32px;height:32px}
.card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);border-radius:20px;overflow:hidden}
.card.plain{border:0;background:transparent;overflow:visible}
.cover{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#3A2C1F}
.body{padding:20px}
.who{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#3A2C1F;flex:none;border:1px solid var(--border)}
.avatar.lg{width:96px;height:96px;margin:4px auto 12px;display:block}
.name{font-weight:600}
.muted{color:var(--muted);font-size:14px}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 12px;overflow-wrap:anywhere}
.center{text-align:center}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--live);color:#fff;margin-bottom:10px}
.badge.off{background:#3A2C1F;color:var(--muted)}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.btn{display:block;text-align:center;padding:14px 16px;border-radius:14px;font-weight:700;text-decoration:none;color:var(--ink);background:linear-gradient(135deg,var(--gold-light),var(--gold) 45%,var(--gold-deep))}
.btn.secondary{background:transparent;border:1px solid var(--border);color:var(--text);font-weight:600}
.foot{margin-top:24px;font-size:13px;color:var(--muted);text-align:center;max-width:440px}
`;

/** The BigBoss mark: a gold disc with "BB", served at /assets/logo.svg. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.goldLight}"/><stop offset=".45" stop-color="${palette.gold}"/><stop offset="1" stop-color="${palette.goldDeep}"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#g)"/><text x="32" y="41" text-anchor="middle" font-family="Georgia,serif" font-size="26" font-weight="700" fill="${palette.ink}">BB</text></svg>`;

/**
 * Served at /assets/open.js on Android content pages: follows the "Open in BigBoss Live" intent
 * link as soon as the page loads. Without the app, Chrome comes back with ?open=0 (no script).
 * In-app browsers that block it still have the button.
 */
export const OPEN_JS = `(function(){var a=document.querySelector('a[data-auto-open]');if(a)window.location.replace(a.href);})();
`;
