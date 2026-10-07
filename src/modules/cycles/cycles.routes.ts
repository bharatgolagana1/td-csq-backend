import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import {
  createCycleBody,
  currentCycleQuery,
  currentCycleResponse,
  cycleDetailResponse,
  cycleListQuery,
  cycleSummaryResponse,
  monitoringResponse,
  participantListQuery,
  participantResponse,
  patchCycleBody,
  reminderRunResponse,
  sendRemindersBody,
  transitionBody,
} from './cycles.schemas.js';
import {
  createCycle,
  currentCycles,
  getCycle,
  listCycleParticipants,
  listCycles,
  publishCycle,
  transition,
  updateCycle,
} from './cycles.service.js';
import { getMonitoring } from './monitoring.service.js';
import { sendRemindersNow } from './reminders.service.js';

const cycleParams = z.object({ id: idSchema });

export const cyclesRoutes = [
  route({
    method: 'get',
    path: '/cycles',
    policy: { kind: 'task', task: 'cycles.view' },
    summary: 'List cycles (PLATFORM all; ACO / AIRPORT those they take part in) with progress',
    query: cycleListQuery,
    response: z.array(cycleSummaryResponse),
    handler: ({ ctx, query }) => listCycles(ctx, query),
  }),
  route({
    method: 'post',
    path: '/cycles',
    policy: { kind: 'task', task: 'cycles.manage' },
    summary: 'Create a DRAFT cycle; windows derived from initiationDate + settings.defaults when omitted',
    body: createCycleBody,
    response: cycleDetailResponse,
    status: 201,
    handler: ({ ctx, body }) => createCycle(ctx, body),
  }),
  // Before /cycles/:id so "current" is never parsed as an id.
  route({
    method: 'get',
    path: '/cycles/current',
    policy: { kind: 'task', task: 'cycles.view' },
    summary: 'The cycle strip: cycles an operator must act on now, with its participant and next deadline',
    query: currentCycleQuery,
    response: z.array(currentCycleResponse),
    handler: ({ ctx, query }) => currentCycles(ctx, query),
  }),
  route({
    method: 'get',
    path: '/cycles/:id',
    policy: { kind: 'task', task: 'cycles.view' },
    summary: 'Cycle with participants (operator + airport), survey versions and the market-share frozen flag',
    params: cycleParams,
    response: cycleDetailResponse,
    handler: ({ ctx, params }) => getCycle(ctx, params.id),
  }),
  route({
    method: 'patch',
    path: '/cycles/:id',
    policy: { kind: 'task', task: 'cycles.manage' },
    summary: 'DRAFT: any field; PUBLISHED and later: end-date extensions and reminder settings (audited)',
    params: cycleParams,
    body: patchCycleBody,
    response: cycleDetailResponse,
    handler: ({ ctx, params, body }) => updateCycle(ctx, params.id, body),
  }),
  route({
    method: 'post',
    path: '/cycles/:id/publish',
    policy: { kind: 'task', task: 'cycles.publish' },
    summary: 'Publish: windows, market shares (snapshot), surveys; creates participants; e-mails ACO admins',
    params: cycleParams,
    response: cycleDetailResponse,
    handler: ({ ctx, params }) => publishCycle(ctx, params.id),
  }),
  route({
    method: 'post',
    path: '/cycles/:id/transition',
    policy: { kind: 'task', task: 'cycles.operate' },
    summary: 'Manual, reasoned, audited override of the cycle clock',
    params: cycleParams,
    body: transitionBody,
    response: cycleDetailResponse,
    handler: ({ ctx, params, body }) => transition(ctx, params.id, body.to, body.reason, { trigger: 'MANUAL' }),
  }),
  route({
    method: 'get',
    path: '/cycles/:id/participants',
    policy: { kind: 'task', task: 'cycles.view' },
    summary: 'Per-operator sampling and assessment progress',
    params: cycleParams,
    query: participantListQuery,
    response: z.array(participantResponse),
    handler: ({ ctx, params, query }) => listCycleParticipants(ctx, params.id, query),
  }),
  route({
    method: 'get',
    path: '/cycles/:id/monitoring',
    policy: { kind: 'task', task: 'monitoring.view' },
    summary: 'Sampling / assessment totals and the Airport → ACO drill-down',
    params: cycleParams,
    response: monitoringResponse,
    handler: ({ ctx, params }) => getMonitoring(ctx, params.id),
  }),
  route({
    method: 'post',
    path: '/cycles/:id/reminders/send',
    policy: { kind: 'task', task: 'cycles.operate' },
    summary: 'Manual reminder run: SAMPLING (cycles) or ASSESSMENT (forwarded to the sender invitations registers; 412 until then)',
    params: cycleParams,
    body: sendRemindersBody,
    response: reminderRunResponse,
    handler: ({ ctx, params, body }) => sendRemindersNow(ctx, params.id, body),
  }),
];
