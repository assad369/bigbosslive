import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { apiPreviewFetcher } from './preview.js';
import { apiDeletionSubmitter } from './deletion.js';
import { unfilledOperatorFields } from './legal/operator.js';

const config = loadConfig();
if (!config.iosAppId) {
  console.warn(
    'APPLE_TEAM_ID is not set: apple-app-site-association is a 404, iOS Universal Links are off.',
  );
}
if (config.ANDROID_SHA256_FINGERPRINTS.length === 0) {
  console.warn('ANDROID_SHA256_FINGERPRINTS is empty: Android App Links cannot verify.');
}

const unfilled = unfilledOperatorFields();
if (unfilled.length) {
  console.warn(
    `Legal pages still have placeholders (src/legal/operator.ts): ${unfilled.join(', ')}. Fill them in before publishing.`,
  );
}

const app = createApp(config, apiPreviewFetcher(config), apiDeletionSubmitter(config));
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  console.warn(`link-web listening on :${info.port} for ${config.PUBLIC_HOST}`),
);

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
