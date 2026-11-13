import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV === 'development' && process.stdout.isTTY;

/**
 * Structured JSON logs (manual 5.4). Sensitive fields are redacted so passwords,
 * tokens and cookies never reach log storage.
 */
export const logger = pino({
  level,
  base: { service: 'enile-crm', env: process.env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.currentPassword',
      '*.newPassword',
    ],
    censor: '[redacted]',
  },
  ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
});
