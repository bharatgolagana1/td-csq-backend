import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import { getMarketShare, putMarketShare } from './market-share.service.js';
import { createOperator, deactivateOperator, getOperator, listOperators, updateOperator } from './operators.service.js';
import {
  createOperatorBody,
  marketShareBody,
  marketShareQuery,
  marketShareResponse,
  operatorListQuery,
  operatorResponse,
  patchOperatorBody,
} from './organisations.schemas.js';

const operatorParams = z.object({ id: idSchema });
const airportParams = z.object({ id: idSchema });

export const organisationsRoutes = [
  route({
    method: 'get',
    path: '/operators',
    policy: { kind: 'task', task: 'operators.view' },
    summary: 'List ACO operators with airport, member and customer counts',
    query: operatorListQuery,
    response: z.array(operatorResponse),
    handler: ({ ctx, query }) => listOperators(ctx, query),
  }),
  route({
    method: 'post',
    path: '/operators',
    policy: { kind: 'task', task: 'operators.manage' },
    summary: 'Create an ACTIVE operator with an INVITED admin user',
    body: createOperatorBody,
    response: operatorResponse,
    status: 201,
    handler: ({ ctx, body }) => createOperator(ctx, body),
  }),
  route({
    method: 'get',
    path: '/operators/:id',
    policy: { kind: 'task', task: 'operators.view' },
    params: operatorParams,
    response: operatorResponse,
    handler: ({ ctx, params }) => getOperator(ctx, params.id),
  }),
  route({
    method: 'patch',
    path: '/operators/:id',
    policy: { kind: 'task', task: 'operators.manage' },
    params: operatorParams,
    body: patchOperatorBody,
    response: operatorResponse,
    handler: ({ ctx, params, body }) => updateOperator(ctx, params.id, body),
  }),
  route({
    method: 'post',
    path: '/operators/:id/deactivate',
    policy: { kind: 'task', task: 'operators.manage' },
    params: operatorParams,
    response: operatorResponse,
    handler: ({ ctx, params }) => deactivateOperator(ctx, params.id),
  }),

  route({
    method: 'get',
    path: '/airports/:id/market-share',
    policy: { kind: 'task', task: 'marketshare.view' },
    summary: 'Market shares at an airport (current, or a cycle snapshot with ?cycleId=)',
    params: airportParams,
    query: marketShareQuery,
    response: marketShareResponse,
    handler: ({ ctx, params, query }) => getMarketShare(ctx, params.id, query.cycleId ?? null),
  }),
  route({
    method: 'put',
    path: '/airports/:id/market-share',
    policy: { kind: 'task', task: 'marketshare.manage' },
    summary: 'Replace the market-share set; total must be 100; refused when frozen',
    params: airportParams,
    body: marketShareBody,
    response: marketShareResponse,
    handler: ({ ctx, params, body }) => putMarketShare(ctx, params.id, body),
  }),
];
