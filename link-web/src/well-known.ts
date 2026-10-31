import type { Config } from './config.js';
import { ROUTES } from './contract.js';

/** Digital Asset Links statement that lets Android verify the app for this host. */
export function assetLinks(c: Config) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: c.ANDROID_PACKAGE,
        sha256_cert_fingerprints: c.ANDROID_SHA256_FINGERPRINTS,
      },
    },
  ];
}

/**
 * Apple App Site Association. `appIDs` + `components` is the iOS 13+ format; `appID` + `paths`
 * keeps iOS 12 working. Only content prefixes are claimed, so `/` stays on the web.
 */
export function appleAppSiteAssociation(c: Config) {
  if (!c.iosAppId) return null;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [c.iosAppId],
          components: ROUTES.map((r) => ({ '/': `/${r.prefix}/*`, comment: `${r.kind} links` })),
          appID: c.iosAppId,
          paths: ROUTES.map((r) => `/${r.prefix}/*`),
        },
      ],
    },
  };
}
