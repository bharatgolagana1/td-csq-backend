import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';
import { requestIdOf } from '../../core/request-id.js';

import { createLink, deleteLink, getPublicLink, listLinks } from './links.service.js';
import { registrationRateLimit } from './onboarding.ratelimit.js';
import {
  approveRegistrationBody,
  createdLinkResponse,
  createLinkBody,
  linkListQuery,
  onboardingLinkResponse,
  publicLinkResponse,
  registrationDetailResponse,
  registrationFormBody,
  registrationListQuery,
  registrationResponse,
  registrationSubmittedResponse,
  rejectRegistrationBody,
  tokenParams,
} from './onboarding.schemas.js';
import { approveRegistration, getRegistration, listRegistrations, rejectRegistration, submitRegistration } from './registrations.service.js';

const linkParams = z.object({ id: idSchema });
const registrationParams = z.object({ id: idSchema });

export const onboardingRoutes = [
  route({
    method: 'post',
    path: '/onboarding/links',
    policy: { kind: 'task', task: 'onboarding.links' },
    summary: 'Create a self-registration link; the raw token appears only in this response',
    body: createLinkBody,
    response: createdLinkResponse,
    status: 201,
    handler: ({ ctx, body }) => createLink(ctx, body),
  }),
  route({
    method: 'get',
    path: '/onboarding/links',
    policy: { kind: 'task', task: 'onboarding.links' },
    summary: 'List onboarding links with their derived status (OPEN, USED, EXPIRED)',
    query: linkListQuery,
    response: z.array(onboardingLinkResponse),
    handler: ({ ctx, query }) => listLinks(ctx, query),
  }),
  route({
    method: 'delete',
    path: '/onboarding/links/:id',
    policy: { kind: 'task', task: 'onboarding.links' },
    summary: 'Revoke an unused link',
    params: linkParams,
    handler: ({ ctx, params }) => deleteLink(ctx, params.id),
  }),

  route({
    method: 'get',
    path: '/public/onboarding/:token',
    policy: { kind: 'public' },
    summary: 'What the registration form needs: 404 unknown, 410 expired, used flag',
    params: tokenParams,
    response: publicLinkResponse,
    handler: ({ params }) => getPublicLink(params.token),
  }),
  route({
    method: 'post',
    path: '/public/onboarding/:token',
    policy: { kind: 'public' },
    summary: 'Submit the registration form (rate-limited per IP); marks the link used',
    before: [registrationRateLimit.middleware],
    params: tokenParams,
    body: registrationFormBody,
    response: registrationSubmittedResponse,
    status: 201,
    handler: ({ params, body, req }) => submitRegistration(params.token, body, { ip: req.ip ?? '', requestId: requestIdOf(req) }),
  }),

  route({
    method: 'get',
    path: '/registrations',
    policy: { kind: 'task', task: 'onboarding.review' },
    summary: 'List registration requests (filter status, orgType, airportId)',
    query: registrationListQuery,
    response: z.array(registrationResponse),
    handler: ({ ctx, query }) => listRegistrations(ctx, query),
  }),
  route({
    method: 'get',
    path: '/registrations/:id',
    policy: { kind: 'task', task: 'onboarding.review' },
    summary: "One registration with the airport's current market-share set and the projected total",
    params: registrationParams,
    response: registrationDetailResponse,
    handler: ({ ctx, params }) => getRegistration(ctx, params.id),
  }),
  route({
    method: 'post',
    path: '/registrations/:id/approve',
    policy: { kind: 'task', task: 'onboarding.review' },
    summary: 'Approve: creates the ACTIVE organisation, the INVITED admin and membership, the share; e-mails the admin',
    params: registrationParams,
    body: approveRegistrationBody,
    response: registrationDetailResponse,
    handler: ({ ctx, params, body }) => approveRegistration(ctx, params.id, body),
  }),
  route({
    method: 'post',
    path: '/registrations/:id/reject',
    policy: { kind: 'task', task: 'onboarding.review' },
    summary: 'Reject with a note; e-mails the applicant',
    params: registrationParams,
    body: rejectRegistrationBody,
    response: registrationDetailResponse,
    handler: ({ ctx, params, body }) => rejectRegistration(ctx, params.id, body),
  }),
];
