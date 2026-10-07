import { z } from 'zod';

import { assertTask } from '../../core/auth/rbac.js';
import { route } from '../../core/http.js';
import { assessmentFormResponse, draftResponse, patchAnswersResponse, readinessResponse } from '../assessments/assessments.schemas.js';

import {
  answersBody,
  invitationListQuery,
  invitationParams,
  invitationResponse,
  otpResponse,
  participantStatusResponse,
  submitResponse,
  tokenParams,
  verifyBody,
  verifyResponse,
} from './invitations.schemas.js';
import { listInvitations, resendInvitation, revokeInvitation } from './invitations.service.js';
import {
  participantDraft,
  participantForm,
  participantPatchAnswers,
  participantReadiness,
  participantStatus,
  participantSubmit,
  requestOtp,
  verifyOtp,
} from './participant.service.js';

/**
 * ARCHITECTURE §6 guards these routes with `cycles.view`, `notifications.send`
 * and `sampling.manage`, tasks other modules declare; the registry only admits a
 * task policy for the module's own tasks, so the routes take a session and
 * assert the task in the handler (same check, same 403).
 */
const PARTICIPANT = { kind: 'link', audience: 'participant' } as const;

export const invitationsRoutes = [
  // --- signed-in ---------------------------------------------------------------
  route({
    method: 'get',
    path: '/invitations',
    policy: { kind: 'session' },
    summary: 'List invitations in scope with masked identity (task cycles.view; filters cycleId, acoId, state, surveyType)',
    query: invitationListQuery,
    response: z.array(invitationResponse),
    handler: ({ ctx, query }) => {
      assertTask(ctx, 'cycles.view');
      return listInvitations(ctx, query);
    },
  }),
  route({
    method: 'post',
    path: '/invitations/:id/resend',
    policy: { kind: 'session' },
    summary: 'New token, state SENT, invitation e-mail again; the old link dies (task notifications.send; audited)',
    params: invitationParams,
    response: invitationResponse,
    handler: ({ ctx, params }) => {
      assertTask(ctx, 'notifications.send');
      return resendInvitation(ctx, params.id);
    },
  }),
  route({
    method: 'post',
    path: '/invitations/:id/revoke',
    policy: { kind: 'session' },
    summary: 'The link stops working; terminal (task sampling.manage; audited)',
    params: invitationParams,
    response: invitationResponse,
    handler: ({ ctx, params }) => {
      assertTask(ctx, 'sampling.manage');
      return revokeInvitation(ctx, params.id);
    },
  }),

  // --- public participant flow --------------------------------------------------
  route({
    method: 'get',
    path: '/public/assess/:token',
    policy: { kind: 'public' },
    summary: 'The invitation behind a link: state (EXPIRED once past the window), cycle, operator, masked participant; SENT → OPENED',
    params: tokenParams,
    response: participantStatusResponse,
    handler: ({ params }) => participantStatus(params.token),
  }),
  route({
    method: 'post',
    path: '/public/assess/:token/otp',
    policy: { kind: 'public' },
    summary: 'E-mail a six-digit code (10 min); 30 s cooldown, 3 per 10 min per link, budget per address; devOtp when DEMO_REVEAL_OTP',
    params: tokenParams,
    response: otpResponse,
    handler: ({ params, req }) => requestOtp(params.token, { ip: req.ip }),
  }),
  route({
    method: 'post',
    path: '/public/assess/:token/verify',
    policy: { kind: 'public' },
    summary: 'Check the code (5 attempts) → VERIFIED and a 12 h link session { inv, asg, aco }',
    params: tokenParams,
    body: verifyBody,
    response: verifyResponse,
    handler: ({ params, body }) => verifyOtp(params.token, body.otp),
  }),
  route({
    method: 'get',
    path: '/public/assess/:token/form',
    policy: PARTICIPANT,
    summary: 'The survey form for the participant’s stakeholder type plus progress',
    params: tokenParams,
    response: assessmentFormResponse,
    handler: ({ params, link }) => participantForm(params.token, link),
  }),
  route({
    method: 'get',
    path: '/public/assess/:token/draft',
    policy: PARTICIPANT,
    summary: 'The answers saved so far',
    params: tokenParams,
    response: draftResponse,
    handler: ({ params, link }) => participantDraft(params.token, link),
  }),
  route({
    method: 'patch',
    path: '/public/assess/:token/answers',
    policy: PARTICIPANT,
    summary: 'Autosave: merge answers by question; returns progress; 412 once submitted',
    params: tokenParams,
    body: answersBody,
    response: patchAnswersResponse,
    handler: ({ params, link, body }) => participantPatchAnswers(params.token, link, body),
  }),
  route({
    method: 'get',
    path: '/public/assess/:token/readiness',
    policy: PARTICIPANT,
    summary: 'What is still missing before the assessment can be submitted',
    params: tokenParams,
    response: readinessResponse,
    handler: ({ params, link }) => participantReadiness(params.token, link),
  }),
  route({
    method: 'post',
    path: '/public/assess/:token/submit',
    policy: PARTICIPANT,
    summary: 'Lock the assessment: invitation SUBMITTED, participant stats, thank-you e-mail',
    params: tokenParams,
    response: submitResponse,
    handler: ({ params, link }) => participantSubmit(params.token, link),
  }),
];
