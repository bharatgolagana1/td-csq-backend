import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import {
  addMembershipBody,
  createRoleBody,
  createUserBody,
  matrixBody,
  matrixResponse,
  meResponse,
  patchRoleBody,
  patchUserBody,
  roleResponse,
  userListQuery,
  userResponse,
} from './identity.schemas.js';
import { getMatrix, saveMatrix } from './matrix.service.js';
import { getMe } from './me.service.js';
import { createRole, listRoles, updateRole } from './roles.service.js';
import { addMembership, createUser, listUsers, removeMembership, updateUser } from './users.service.js';

const userParams = z.object({ id: idSchema });
const membershipParams = z.object({ id: idSchema, membershipId: idSchema });
const roleParams = z.object({ id: idSchema });

export const identityRoutes = [
  route({
    method: 'get',
    path: '/me',
    policy: { kind: 'session' },
    summary: 'The signed-in user, memberships and active organisation',
    response: meResponse,
    handler: ({ ctx }) => getMe(ctx),
  }),

  route({
    method: 'get',
    path: '/users',
    policy: { kind: 'task', task: 'users.view' },
    summary: 'List users (PLATFORM: all; ACO/AIRPORT: own organisation)',
    query: userListQuery,
    response: z.array(userResponse),
    handler: ({ ctx, query }) => listUsers(ctx, query),
  }),
  route({
    method: 'post',
    path: '/users',
    policy: { kind: 'task', task: 'users.manage' },
    summary: 'Create an INVITED user with one membership and send the invitation',
    body: createUserBody,
    response: userResponse,
    status: 201,
    handler: ({ ctx, body }) => createUser(ctx, body),
  }),
  route({
    method: 'patch',
    path: '/users/:id',
    policy: { kind: 'task', task: 'users.manage' },
    params: userParams,
    body: patchUserBody,
    response: userResponse,
    handler: ({ ctx, params, body }) => updateUser(ctx, params.id, body),
  }),
  route({
    method: 'post',
    path: '/users/:id/memberships',
    policy: { kind: 'task', task: 'users.manage' },
    params: userParams,
    body: addMembershipBody,
    response: userResponse,
    status: 201,
    handler: ({ ctx, params, body }) => addMembership(ctx, params.id, body),
  }),
  route({
    method: 'delete',
    path: '/users/:id/memberships/:membershipId',
    policy: { kind: 'task', task: 'users.manage' },
    params: membershipParams,
    response: userResponse,
    handler: ({ ctx, params }) => removeMembership(ctx, params.id, params.membershipId),
  }),

  route({
    method: 'get',
    path: '/roles',
    policy: { kind: 'task', task: 'roles.view' },
    response: z.array(roleResponse),
    handler: ({ ctx }) => listRoles(ctx),
  }),
  route({
    method: 'post',
    path: '/roles',
    policy: { kind: 'task', task: 'roles.manage' },
    body: createRoleBody,
    response: roleResponse,
    status: 201,
    handler: ({ ctx, body }) => createRole(ctx, body),
  }),
  // Declared before /roles/:id so "matrix" is never read as an id.
  route({
    method: 'get',
    path: '/roles/matrix',
    policy: { kind: 'task', task: 'roles.view' },
    summary: 'The Role → Task matrix',
    response: matrixResponse,
    handler: () => getMatrix(),
  }),
  route({
    method: 'put',
    path: '/roles/matrix',
    policy: { kind: 'task', task: 'roles.manage' },
    summary: 'Whole-matrix save; bumps settings.rbacVersion and audits',
    body: matrixBody,
    response: matrixResponse,
    handler: ({ ctx, body }) => saveMatrix(ctx, body),
  }),
  route({
    method: 'patch',
    path: '/roles/:id',
    policy: { kind: 'task', task: 'roles.manage' },
    params: roleParams,
    body: patchRoleBody,
    response: roleResponse,
    handler: ({ ctx, params, body }) => updateRole(ctx, params.id, body),
  }),
];
