import nodemailer from 'nodemailer';

import type { Env } from '../../config/env.js';
import { logger } from '../../core/logger.js';

import type { NotificationChannel } from './notifications.model.js';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Transport {
  channel: NotificationChannel;
  deliver(message: MailMessage): Promise<void>;
}

/** Writes the message to the log; the notifications row is the only record. */
export function createLogTransport(): Transport {
  return {
    channel: 'LOG',
    async deliver(message) {
      logger.info({ to: message.to, subject: message.subject }, 'E-mail (LOG transport)');
      logger.debug({ text: message.text }, 'E-mail body');
    },
  };
}

export function createSmtpTransport(smtpUrl: string): Transport {
  const mailer = nodemailer.createTransport(smtpUrl);
  return {
    channel: 'EMAIL',
    async deliver(message) {
      await mailer.sendMail(message);
    },
  };
}

/** SMTP when `SMTP_URL` is set, otherwise LOG (ARCHITECTURE §8). */
export function createTransport(env: Pick<Env, 'SMTP_URL'>): Transport {
  return env.SMTP_URL ? createSmtpTransport(env.SMTP_URL) : createLogTransport();
}
