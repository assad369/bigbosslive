import { pino, type Logger } from 'pino';

export type { Logger };

/** pino-pretty is a dev dependency; production images don't ship it. */
function prettyAvailable(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(opts: { level: string; pretty?: boolean }): Logger {
  return pino({
    level: opts.level,
    base: { service: 'bigboss-backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-livekit-signature"]',
        '*.password',
        '*.token',
        '*.idToken',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    ...(opts.pretty && prettyAvailable()
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  });
}
