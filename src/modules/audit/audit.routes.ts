import { z } from 'zod';

import { route } from '../../core/http.js';

import { auditEntryResponse, auditListQuery } from './audit.schemas.js';
import { listAudit } from './audit.service.js';

export const auditRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'audit.view' },
    summary: 'Audit log (filters entity, entityId, orgId, actor, action, from, to)',
    query: auditListQuery,
    response: z.array(auditEntryResponse),
    handler: ({ ctx, query }) => listAudit(ctx, query),
  }),
];
