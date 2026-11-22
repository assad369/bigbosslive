import { Hono, type Context } from 'hono';
import type { Config } from './config.js';
import { byPrefix } from './contract.js';
import {
  autoOpens,
  contentView,
  landingView,
  NO_AUTO_OPEN,
  notFoundView,
  Page,
  type View,
} from './pages.js';
import { detectPlatform } from './platform.js';
import type { PreviewFetcher } from './preview.js';
import type { DeletionSubmitter } from './deletion.js';
import {
  childSafetyView,
  deleteAccountView,
  guidelinesView,
  legalIndexView,
  privacyView,
  refundsView,
  termsView,
} from './legal/pages.js';
import { LOGO_SVG, OPEN_JS, SITE_CSS } from './styles.js';
import { appleAppSiteAssociation, assetLinks } from './well-known.js';

const csp = (formAction: string) =>
  `default-src 'none'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`;

/** The only page with a form: the web account-deletion request. */
const DELETE_ACCOUNT_PATH = '/delete-account';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': csp("'none'"),
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Visitor IP as set by our edge proxy; for X-Forwarded-For, the last hop it appended. */
function clientIp(c: Context, header: string): string | null {
  const raw = c.req.header(header);
  if (!raw) return null;
  const ip = (header === 'x-forwarded-for' ? raw.split(',').pop() : raw)?.trim();
  return ip && ip.length <= 64 ? ip : null;
}

const deletionFailed = async (): Promise<'error'> => 'error';

export function createApp(
  config: Config,
  fetchPreview: PreviewFetcher,
  submitDeletion: DeletionSubmitter = deletionFailed,
) {
  // strict: false → `/live/<id>/` is the same page as `/live/<id>` (no redirect hop).
  const app = new Hono({ strict: false });

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    if (c.req.path.replace(/\/$/, '') === DELETE_ACCOUNT_PATH)
      c.header('Content-Security-Policy', csp("'self'"));
  });

  const render = (c: Context, path: string, view: View) => {
    c.header('Cache-Control', view.maxAge > 0 ? `public, max-age=${view.maxAge}` : 'no-store');
    c.header('Vary', 'User-Agent');
    const platform = detectPlatform(c.req.header('user-agent'));
    const autoOpen = autoOpens(platform, view, c.req.query(NO_AUTO_OPEN) === '0');
    return c.html(
      `<!doctype html>${(
        <Page c={config} platform={platform} autoOpen={autoOpen} path={path} view={view} />
      )}`,
      view.status,
    );
  };

  const asset = (c: Context, body: string, type: string, maxAge = 86400) => {
    c.header('Cache-Control', `public, max-age=${maxAge}`);
    return c.body(body, 200, { 'Content-Type': type });
  };

  app.get('/healthz', (c) => c.text('ok'));

  // Verification files: plain 200 JSON, never redirected (Android and Apple both reject that).
  app.get('/.well-known/assetlinks.json', (c) =>
    asset(c, JSON.stringify(assetLinks(config)), 'application/json', 3600),
  );
  const aasa = (c: Context) => {
    const body = appleAppSiteAssociation(config);
    return body
      ? asset(c, JSON.stringify(body), 'application/json', 3600)
      : c.json({ error: 'iOS app not configured' }, 404);
  };
  app.get('/.well-known/apple-app-site-association', aasa);
  app.get('/apple-app-site-association', aasa);

  app.get('/assets/site.css', (c) => asset(c, SITE_CSS, 'text/css; charset=utf-8'));
  app.get('/assets/open.js', (c) => asset(c, OPEN_JS, 'text/javascript; charset=utf-8', 3600));
  app.get('/assets/logo.svg', (c) => asset(c, LOGO_SVG, 'image/svg+xml'));
  app.get('/favicon.ico', (c) => asset(c, LOGO_SVG, 'image/svg+xml'));
  app.get('/robots.txt', (c) =>
    c.text(`User-agent: *\nAllow: /\nDisallow: ${DELETE_ACCOUNT_PATH}\n`),
  );

  app.get('/', (c) => render(c, '/', landingView()));

  // Legal pages: Play links the privacy policy, child safety standards and deletion URL.
  app.get('/legal', (c) => render(c, '/legal', legalIndexView()));
  app.get('/legal/terms', (c) => render(c, '/legal/terms', termsView()));
  app.get('/legal/privacy', (c) => render(c, '/legal/privacy', privacyView()));
  app.get('/legal/community-guidelines', (c) =>
    render(c, '/legal/community-guidelines', guidelinesView()),
  );
  app.get('/legal/child-safety', (c) => render(c, '/legal/child-safety', childSafetyView()));
  app.get('/legal/refunds', (c) => render(c, '/legal/refunds', refundsView()));
  // Short aliases people type.
  app.get('/privacy', (c) => c.redirect('/legal/privacy', 301));
  app.get('/terms', (c) => c.redirect('/legal/terms', 301));
  app.get('/child-safety', (c) => c.redirect('/legal/child-safety', 301));

  app.get(DELETE_ACCOUNT_PATH, (c) => render(c, DELETE_ACCOUNT_PATH, deleteAccountView()));
  app.post(DELETE_ACCOUNT_PATH, async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const contact = field('contact');
    const reason = field('reason').slice(0, 500);
    if (contact.length < 3 || contact.length > 120) {
      const view = deleteAccountView({
        kind: 'form',
        contact,
        reason,
        problem: 'Enter the phone number, email or numeric ID of the account.',
      });
      return render(c, DELETE_ACCOUNT_PATH, view);
    }
    const result = await submitDeletion({ contact, reason }, clientIp(c, config.CLIENT_IP_HEADER));
    const view =
      result === 'sent'
        ? deleteAccountView({ kind: 'sent' })
        : deleteAccountView({
            kind: 'error',
            message:
              result === 'rate_limited'
                ? 'Too many requests from this network. Try again in an hour, or email us.'
                : 'We could not send your request. Try again, or email us.',
          });
    return render(c, DELETE_ACCOUNT_PATH, view);
  });

  app.get('/:prefix/:id', async (c) => {
    const route = byPrefix.get(c.req.param('prefix'));
    const id = c.req.param('id');
    if (!route || !route.id.test(id)) return render(c, c.req.path, notFoundView());
    const path = `/${route.prefix}/${id}`;
    const result = await fetchPreview(route.kind, id, clientIp(c, config.CLIENT_IP_HEADER));
    return render(c, path, contentView(result));
  });

  app.notFound((c) => render(c, c.req.path, notFoundView()));
  app.onError((err, c) => {
    console.error(err);
    const view = notFoundView('Something went wrong', 'Please try again in a moment.');
    return render(c, '/', { ...view, maxAge: 0 });
  });

  return app;
}
