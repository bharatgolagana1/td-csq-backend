import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';
import { ORG_STATUSES, ORG_TYPES } from '../organisations/organisations.model.js';

import { MEMBERSHIP_STATUSES } from './memberships.model.js';
import { ROLE_SCOPES } from './roles.model.js';
import { USER_STATUSES } from './users.model.js';

export const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

export const roleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'must be UPPER_SNAKE_CASE, 2-40 characters');

const phoneSchema = z.string().trim().min(3).max(32);

// --- memberships -----------------------------------------------------------

export const membershipResponse = z.object({
  id: z.string(),
  orgId: z.string(),
  orgCode: z.string(),
  orgName: z.string(),
  orgType: z.enum(ORG_TYPES),
  orgStatus: z.enum(ORG_STATUSES),
  airportId: z.string().nullable(),
  roleId: z.string(),
  roleCode: z.string(),
  roleName: z.string(),
  status: z.enum(MEMBERSHIP_STATUSES),
});

export type MembershipDto = z.infer<typeof membershipResponse>;

export const addMembershipBody = z.object({ orgId: idSchema, roleCode: roleCodeSchema }).strict();
export type AddMembershipInput = z.infer<typeof addMembershipBody>;

// --- users -----------------------------------------------------------------

export const userResponse = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  lastLoginAt: z.string().nullable(),
  memberships: z.array(membershipResponse),
  createdAt: z.string(),
});

export type UserDto = z.infer<typeof userResponse>;

export const userListQuery = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  /** PLATFORM only: members of one organisation. */
  orgId: idSchema.optional(),
});
export type UserListQuery = z.infer<typeof userListQuery>;

export const createUserBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    phone: phoneSchema.optional(),
    orgId: idSchema,
    roleCode: roleCodeSchema,
  })
  .strict();
export type CreateUserInput = z.infer<typeof createUserBody>;

export const patchUserBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: phoneSchema.nullable().optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .strict();
export type PatchUserInput = z.infer<typeof patchUserBody>;

// --- roles -----------------------------------------------------------------

export const roleResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  scope: z.enum(ROLE_SCOPES),
  system: z.boolean(),
  taskCount: z.number(),
});
export type RoleDto = z.infer<typeof roleResponse>;

export const createRoleBody = z
  .object({
    code: roleCodeSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
    scope: z.enum(ROLE_SCOPES),
  })
  .strict();
export type CreateRoleInput = z.infer<typeof createRoleBody>;

export const patchRoleBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export type PatchRoleInput = z.infer<typeof patchRoleBody>;

// --- matrix ----------------------------------------------------------------

export const matrixResponse = z.object({
  tasks: z.array(z.object({ code: z.string(), module: z.string(), name: z.string(), description: z.string() })),
  roles: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      scope: z.enum(ROLE_SCOPES),
      system: z.boolean(),
      tasks: z.array(z.string()),
    }),
  ),
});
export type MatrixDto = z.infer<typeof matrixResponse>;

export const matrixBody = z
  .object({
    roles: z.array(z.object({ roleId: idSchema, tasks: z.array(z.string().trim().min(1)) }).strict()).min(1),
  })
  .strict();
export type MatrixInput = z.infer<typeof matrixBody>;

// --- me --------------------------------------------------------------------

export const meResponse = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    status: z.enum(USER_STATUSES),
    lastLoginAt: z.string().nullable(),
  }),
  memberships: z.array(
    z.object({
      id: z.string(),
      orgId: z.string(),
      orgCode: z.string(),
      orgName: z.string(),
      orgType: z.enum(ORG_TYPES),
      roleCode: z.string(),
      roleName: z.string(),
      airportId: z.string().nullable(),
    }),
  ),
  active: z.object({
    orgId: z.string(),
    orgType: z.enum(ORG_TYPES),
    roleCode: z.string(),
    tasks: z.array(z.string()),
    scope: z.union([
      z.object({ kind: z.literal('PLATFORM') }),
      z.object({ kind: z.literal('ACO'), acoId: z.string() }),
      z.object({ kind: z.literal('AIRPORT'), airportId: z.string() }),
    ]),
  }),
});
export type MeDto = z.infer<typeof meResponse>;
