import { z } from 'zod';

import { route } from '../../core/http.js';
import { auditEntryResponse } from '../audit/audit.schemas.js';

import {
  acoBody,
  acoQuery,
  customerParams,
  cycleParams,
  participationResponse,
  samplingAuditQuery,
  selectionBody,
  selectionChangeResponse,
  selectionStateResponse,
  unlockBody,
} from './sampling.schemas.js';
import { changeSelection, getParticipation, getSelectionState, listSamplingAudit, lock, selectAll, unlock } from './sampling.service.js';

export const samplingRoutes = [
  route({
    method: 'get',
    path: '/sampling/cycles/:cycleId',
    policy: { kind: 'task', task: 'sampling.view' },
    summary: 'Selection state for the operator in a cycle (PLATFORM: ?acoId=)',
    params: cycleParams,
    query: acoQuery,
    response: selectionStateResponse,
    handler: ({ ctx, params, query }) => getSelectionState(ctx, params.cycleId, query.acoId),
  }),
  route({
    method: 'put',
    path: '/sampling/cycles/:cycleId/selection',
    policy: { kind: 'task', task: 'sampling.manage' },
    summary: 'Add / remove (customer, surveyType) entries while sampling is open and not locked',
    params: cycleParams,
    body: selectionBody,
    response: selectionChangeResponse,
    handler: ({ ctx, params, body }) => changeSelection(ctx, params.cycleId, body),
  }),
  route({
    method: 'post',
    path: '/sampling/cycles/:cycleId/select-all',
    policy: { kind: 'task', task: 'sampling.manage' },
    summary: 'Select every eligible entry; allowed only when eligible < required',
    params: cycleParams,
    body: acoBody,
    response: selectionChangeResponse,
    handler: ({ ctx, params, body }) => selectAll(ctx, params.cycleId, body.acoId),
  }),
  route({
    method: 'post',
    path: '/sampling/cycles/:cycleId/lock',
    policy: { kind: 'task', task: 'sampling.lock' },
    summary: 'Lock the sample (transaction): gate, samples LOCKED, participant LOCKED, sample.locked',
    params: cycleParams,
    body: acoBody,
    response: selectionStateResponse,
    handler: ({ ctx, params, body }) => lock(ctx, params.cycleId, body.acoId),
  }),
  route({
    method: 'post',
    path: '/sampling/cycles/:cycleId/unlock',
    policy: { kind: 'task', task: 'sampling.unlock' },
    summary: 'PLATFORM only: unlock a locked sample with a reason; sample.unlocked',
    params: cycleParams,
    body: unlockBody,
    response: selectionStateResponse,
    handler: ({ ctx, params, body }) => unlock(ctx, params.cycleId, body.acoId, body.reason),
  }),
  route({
    method: 'get',
    path: '/sampling/cycles/:cycleId/audit',
    policy: { kind: 'task', task: 'sampling.view' },
    summary: 'Audit entries (sample.*) for the operator in this cycle',
    params: cycleParams,
    query: samplingAuditQuery,
    response: z.array(auditEntryResponse),
    handler: ({ ctx, params, query }) => listSamplingAudit(ctx, params.cycleId, query),
  }),
  route({
    method: 'get',
    path: '/customers/:id/participation',
    policy: { kind: 'task', task: 'sampling.view' },
    summary: 'Cycles the customer was sampled in, with sample state and submitted flag',
    params: customerParams,
    query: acoQuery,
    response: participationResponse,
    handler: ({ ctx, params, query }) => getParticipation(ctx, params.id, query.acoId),
  }),
];
