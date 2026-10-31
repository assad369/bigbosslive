import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Config } from './config.js';
import type { Platform } from './platform.js';
import type { Person, PreviewResult } from './preview.js';
import { ESPRESSO } from './styles.js';

const APP = 'BigBoss Live';

/** Only absolute https URLs may be used as images (CSP img-src https:, no javascript:/data:). */
export const safeImage = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

export interface View {
  status: 200 | 404;
  /** Page and OpenGraph title. */
  title: string;
  description: string;
  image: string | null;
  noindex: boolean;
  /** Seconds; 0 = no-store. */
  maxAge: number;
  /** Whether the "open in app" handoff makes sense (false on the 404 and landing pages). */
  openInApp: boolean;
  body: unknown;
}

interface PageProps {
  c: Config;
  platform: Platform;
  /** Hand off to the app on load (Android, content pages, not after a failed handoff). */
  autoOpen: boolean;
  /** Canonical path of this link on PUBLIC_HOST (for og:url, the intent and app-argument). */
  path: string;
  view: View;
}

const Avatar: FC<{ p: Person; large?: boolean }> = ({ p, large }) => {
  const src = safeImage(p.avatarUrl);
  const cls = large ? 'avatar lg' : 'avatar';
  return src ? <img class={cls} src={src} alt="" /> : <span class={cls} />;
};

const Who: FC<{ p: Person }> = ({ p }) => (
  <div class="who">
    <Avatar p={p} />
    <div>
      <div class="name">{p.displayName}</div>
      <div class="muted">ID {p.shortId}</div>
    </div>
  </div>
);

const Card: FC<PropsWithChildren<{ cover?: string | null }>> = ({ cover, children }) => (
  <main class="card">
    {cover ? <img class="cover" src={cover} alt="" /> : null}
    <div class="body">{children}</div>
  </main>
);

/** The page for a share link, built only from backend data (never from the URL). */
export function contentView(result: PreviewResult): View {
  const base = { status: 200 as const, noindex: false, openInApp: true, maxAge: 60 };
  if (result.state === 'not_found') {
    return notFoundView(
      'This is no longer available',
      'It may have been removed, or the link is incorrect.',
    );
  }
  if (result.state === 'unavailable') {
    return {
      ...base,
      maxAge: 0,
      noindex: true,
      title: `Open in ${APP}`,
      description: `Watch lives, join parties and chat with friends on ${APP}.`,
      image: null,
      body: (
        <Card>
          <h1>Open this link in {APP}</h1>
          <p class="muted">
            We couldn’t load a preview right now. You can still open it in the app.
          </p>
        </Card>
      ),
    };
  }

  const d = result.data;
  switch (d.kind) {
    case 'live': {
      const party = d.type === 'audio';
      const ended = d.status === 'ended';
      const name = d.host.displayName;
      const heading = ended
        ? `${name}’s ${party ? 'party' : 'live'} has ended`
        : d.title || `${name} is ${party ? 'hosting a party' : 'live'}`;
      return {
        ...base,
        maxAge: 30,
        title: ended ? heading : `${name} is ${party ? 'hosting a party' : 'live'} on ${APP}`,
        description: ended
          ? `Follow ${name} on ${APP} to catch the next one.`
          : d.title || `Join ${name} now.`,
        image: safeImage(d.coverUrl) ?? safeImage(d.host.avatarUrl),
        body: (
          <Card cover={safeImage(d.coverUrl)}>
            <span class={ended ? 'badge off' : 'badge'}>
              {ended ? 'ENDED' : party ? 'PARTY LIVE' : 'LIVE'}
            </span>
            <h1>{heading}</h1>
            <Who p={d.host} />
            {ended ? (
              <a class="btn secondary" href={`/u/${d.host.shortId}`}>
                View {name}’s profile
              </a>
            ) : null}
          </Card>
        ),
      };
    }
    case 'post': {
      const image = safeImage(d.imageUrl);
      return {
        ...base,
        maxAge: 300,
        title: `${d.author.displayName} on ${APP}`,
        description: d.text.slice(0, 200) || `A moment by ${d.author.displayName}.`,
        image: image ?? safeImage(d.author.avatarUrl),
        body: (
          <Card cover={image}>
            <Who p={d.author} />
            {d.text ? <p>{d.text}</p> : null}
          </Card>
        ),
      };
    }
    case 'user': {
      const u = d.user;
      return {
        ...base,
        maxAge: 300,
        title: `${u.displayName} on ${APP}`,
        description: `${u.followers} followers · ID ${u.shortId}`,
        image: safeImage(u.avatarUrl),
        body: (
          <Card>
            <div class="center">
              <Avatar p={u} large />
              <h1>{u.displayName}</h1>
              <p class="muted">
                ID {u.shortId} · Level {u.level} · {u.followers} followers
              </p>
            </div>
          </Card>
        ),
      };
    }
  }
}

export function notFoundView(
  heading = 'Page not found',
  text = `This link doesn’t point to anything on ${APP}.`,
): View {
  return {
    status: 404,
    title: `${heading} · ${APP}`,
    description: text,
    image: null,
    noindex: true,
    openInApp: false,
    maxAge: 60,
    body: (
      <Card>
        <h1>{heading}</h1>
        <p class="muted">{text}</p>
      </Card>
    ),
  };
}

export function landingView(): View {
  return {
    status: 200,
    title: APP,
    description: 'Go live, host parties, send gifts and chat with friends.',
    image: null,
    noindex: false,
    openInApp: false,
    maxAge: 3600,
    body: (
      <Card>
        <h1>{APP}</h1>
        <p class="muted">Go live, host parties, send gifts and chat with friends.</p>
      </Card>
    ),
  };
}

/** Query flag for "came back from a failed app handoff": show the page, don't open again. */
export const NO_AUTO_OPEN = 'open';

/**
 * Android: an intent:// URL with the https scheme and our package opens the installed app (also
 * from in-app browsers that ignore App Links). Without the app, Chrome loads the fallback: this
 * same page with `?open=0`, which shows the install options instead of looping.
 */
export const androidIntentUrl = (c: Config, path: string) => {
  const fallback = `https://${c.PUBLIC_HOST}${path}?${NO_AUTO_OPEN}=0`;
  return `intent://${c.PUBLIC_HOST}${path}#Intent;scheme=https;package=${c.ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
};

/** Whether the page should hand off to the Android app as soon as it loads. */
export const autoOpens = (platform: Platform, view: View, fromFallback: boolean) =>
  platform === 'android' && view.openInApp && !fromFallback;

const Actions: FC<{
  c: Config;
  platform: Platform;
  path: string;
  openInApp: boolean;
  autoOpen: boolean;
}> = ({ c, platform, path, openInApp, autoOpen }) => {
  const play = c.androidStoreUrl ? (
    <a class="btn secondary" href={c.androidStoreUrl} rel="noopener">
      Get {APP} for Android
    </a>
  ) : null;
  const appStore = c.appStoreUrl ? (
    <a class="btn secondary" href={c.appStoreUrl} rel="noopener">
      Download on the App Store
    </a>
  ) : null;
  if (platform === 'android') {
    return (
      <div class="actions">
        {openInApp ? (
          <a
            class="btn"
            href={androidIntentUrl(c, path)}
            data-auto-open={autoOpen ? '1' : undefined}
          >
            Open in {APP}
          </a>
        ) : null}
        {play ??
          (openInApp ? (
            <p class="muted center">Don’t have the app yet? {APP} for Android is coming soon.</p>
          ) : null)}
      </div>
    );
  }
  if (platform === 'ios') {
    // Safari's Smart App Banner (apple-itunes-app meta) offers "Open" when the app is installed.
    return (
      <div class="actions">
        {c.appStoreUrl ? (
          <a class="btn" href={c.appStoreUrl} rel="noopener">
            Get {APP} on the App Store
          </a>
        ) : (
          <p class="muted center">{APP} for iPhone is coming soon.</p>
        )}
      </div>
    );
  }
  return (
    <div class="actions">
      {appStore}
      {play}
    </div>
  );
};

export const Page: FC<PageProps> = ({ c, platform, autoOpen, path, view }) => {
  const url = `https://${c.PUBLIC_HOST}${path}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{view.title}</title>
        <meta name="description" content={view.description} />
        {view.noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
        {view.status === 200 ? <link rel="canonical" href={url} /> : null}
        <meta property="og:site_name" content={APP} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={view.title} />
        <meta property="og:description" content={view.description} />
        <meta property="og:url" content={url} />
        {view.image ? <meta property="og:image" content={view.image} /> : null}
        <meta name="twitter:card" content={view.image ? 'summary_large_image' : 'summary'} />
        <meta name="twitter:title" content={view.title} />
        <meta name="twitter:description" content={view.description} />
        {view.image ? <meta name="twitter:image" content={view.image} /> : null}
        {c.IOS_APP_STORE_ID ? (
          <meta
            name="apple-itunes-app"
            content={`app-id=${c.IOS_APP_STORE_ID}${view.openInApp ? `, app-argument=${url}` : ''}`}
          />
        ) : null}
        <meta name="theme-color" content={ESPRESSO} />
        <link rel="icon" type="image/svg+xml" href="/assets/logo.svg" />
        <link rel="stylesheet" href="/assets/site.css" />
        {autoOpen ? <script src="/assets/open.js" defer /> : null}
      </head>
      <body>
        <a class="brand" href="/">
          <img src="/assets/logo.svg" alt="" width="32" height="32" />
          {APP}
        </a>
        {view.body}
        <div class="card plain">
          <Actions
            c={c}
            platform={platform}
            path={path}
            openInApp={view.openInApp}
            autoOpen={autoOpen}
          />
        </div>
        <p class="foot">{APP}: go live, host parties and chat with friends.</p>
      </body>
    </html>
  );
};
