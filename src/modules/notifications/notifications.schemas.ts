import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';

import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from './notifications.model.js';

export const notificationListQuery = listQuerySchema.extend({
  cycleId: idSchema.optional(),
  acoId: idSchema.optional(),
  userId: idSchema.optional(),
  template: z.string().trim().min(1).max(64).optional(),
  status: z.enum(NOTIFICATION_STATUSES).optional(),
});

export type NotificationListQuery = z.infer<typeof notificationListQuery>;

const refs = z.object({
  cycleId: z.string().nullable(),
  acoId: z.string().nullable(),
  customerId: z.string().nullable(),
  invitationId: z.string().nullable(),
  userId: z.string().nullable(),
});

export const notificationResponse = z.object({
  id: z.string(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  template: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  vars: z.record(z.string(), z.unknown()),
  refs,
  status: z.enum(NOTIFICATION_STATUSES),
  error: z.string().nullable(),
  sentAt: z.string().nullable(),
  resendOf: z.string().nullable(),
  createdAt: z.string(),
});

export type NotificationDto = z.infer<typeof notificationResponse>;
