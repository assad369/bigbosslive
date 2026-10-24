import { pino, type Logger } from 'pino';

export type { Logger };

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
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  });
}
