import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';

export const auditListQuery = listQuerySchema.extend({
  entity: z.string().trim().min(1).max(64).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
  orgId: idSchema.optional(),
  /** Matches the actor's e-mail (contains) or user id (exact). */
  actor: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type AuditListQuery = z.infer<typeof auditListQuery>;

export const auditEntryResponse = z.object({
  id: z.string(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorOrgId: z.string().nullable(),
  orgId: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  ip: z.string(),
  requestId: z.string(),
  at: z.string(),
});

export type AuditEntryDto = z.infer<typeof auditEntryResponse>;
