import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/** Email is the v1 reminder channel. Without SMTP_HOST, messages are logged instead (dev). */
const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    })
  : null;

export class PermanentSendError extends Error {}

export async function sendEmail(to: string, subject: string, text: string): Promise<string> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new PermanentSendError('Invalid recipient address');
  if (!transport) {
    logger.info({ to, subject }, 'email (log transport)');
    return `log-${Date.now()}`;
  }
  try {
    const info = await transport.sendMail({ from: env.SMTP_FROM, to, subject, text });
    return info.messageId;
  } catch (err) {
    const code = (err as { responseCode?: number }).responseCode;
    // 5xx SMTP responses (bad mailbox etc.) are permanent; don't retry them forever.
    if (code && code >= 500 && code < 600) throw new PermanentSendError((err as Error).message);
    throw err;
  }
}
