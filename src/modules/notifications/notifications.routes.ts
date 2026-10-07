import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import { notificationListQuery, notificationResponse } from './notifications.schemas.js';
import { listNotifications, resendNotification } from './notifications.service.js';

export const notificationsRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'notifications.view' },
    summary: 'Notification log (filters cycleId, acoId, userId, template, status)',
    query: notificationListQuery,
    response: z.array(notificationResponse),
    handler: ({ ctx, query }) => listNotifications(ctx, query),
  }),
  route({
    method: 'post',
    path: '/:id/resend',
    policy: { kind: 'task', task: 'notifications.send' },
    params: z.object({ id: idSchema }),
    response: notificationResponse,
    status: 201,
    handler: ({ ctx, params }) => resendNotification(ctx, params.id),
  }),
];
