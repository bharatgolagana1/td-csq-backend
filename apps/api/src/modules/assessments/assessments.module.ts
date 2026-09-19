import { defineModule } from '../../kernel/router.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import {
  AnswerPatch,
  AssessmentParams,
  AssignmentParams,
  AssignmentQuery,
  CompletionParams,
  CompletionQuery,
  CreateAssignment,
  InstrumentParams,
  InstrumentQuery,
  PublishInstrument,
  ReasonBody,
  WorklistQuery,
} from './assessments.contracts.js';
import { listInstruments, publishInstrument, readInstrument } from './assessments.instruments.js';
import {
  completionFor,
  createAssignment,
  declineAssignment,
  listAssignments,
  readAssignment,
  revokeAssignment,
  worklist,
} from './assessments.assignments.js';
import {
  discardAssessment,
  patchAnswers,
  readAssessment,
  readAssessmentForm,
  readReadiness,
  readSubmission,
  startAssessment,
  submitAssessment,
} from './assessments.service.js';

/**
 * Two capabilities, split by who holds them rather than by verb.
 *
 * RESPOND is held by anyone who has been asked to assess: the operator's own
 * staff, a sampled customer, an auditor. Every route that carries it also
 * checks that the row belongs to the caller, because the capability says you
 * may answer, not that you may answer for somebody else.
 *
 * MANAGE is held by whoever runs the cycle. It reaches every assignment in the
 * organisation and every submitted return, and deliberately does not reach a
 * draft.
 */
export const ASSESSMENTS_RESPOND = 'assessments:respond';
export const ASSESSMENTS_MANAGE = 'assessments:manage';
export const INSTRUMENTS_PUBLISH = 'assessments.instruments:publish';

const userId = (): string => requirePrincipal().userId;

/**
 * Route order matters: the literal paths are registered before /:assessmentId,
 * which would otherwise swallow them. A mismatch is loud rather than silent,
 * because the id is validated as a ULID, but the order is still the contract.
 */
export const assessmentsModule = defineModule({
  name: 'assessments',
  basePath: '/v1/assessments',
  capabilities: [ASSESSMENTS_RESPOND, ASSESSMENTS_MANAGE, INSTRUMENTS_PUBLISH],
  routes: [
    {
      method: 'post',
      path: '/instruments',
      summary: 'Publish a version of the assessment form',
      status: 201,
      // ORG rather than PLATFORM on purpose: the kernel's system scope satisfies
      // every capability check, so a PLATFORM route would be guarded by nothing
      // but authentication. This capability is granted to ACFI staff only.
      policy: { requiredCapability: INSTRUMENTS_PUBLISH, tenancy: 'ORG' },
      handler: (req) => publishInstrument(parseBody(PublishInstrument, req), new Date()),
    },
    {
      method: 'get',
      path: '/instruments',
      summary: 'Published instrument versions',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => listInstruments(parseQuery(InstrumentQuery, req)),
    },
    {
      method: 'get',
      path: '/instruments/:instrumentId',
      summary: 'One published instrument with its questions',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => readInstrument(parseParams(InstrumentParams, req).instrumentId),
    },
    {
      method: 'post',
      path: '/assignments',
      summary: 'Ask an assessor to assess a terminal in a cycle',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => createAssignment(parseBody(CreateAssignment, req), new Date()),
    },
    {
      method: 'get',
      path: '/assignments',
      summary: 'Assignments in this organisation',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => listAssignments(parseQuery(AssignmentQuery, req), new Date()),
    },
    {
      method: 'get',
      path: '/assignments/:assignmentId',
      summary: 'One assignment',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => readAssignment(parseParams(AssignmentParams, req).assignmentId, new Date()),
    },
    {
      method: 'post',
      path: '/assignments/:assignmentId/revoke',
      summary: 'Withdraw an assignment',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) =>
        revokeAssignment(
          parseParams(AssignmentParams, req).assignmentId,
          parseBody(ReasonBody, req).reason,
          new Date(),
        ),
    },
    {
      method: 'post',
      path: '/assignments/:assignmentId/decline',
      summary: 'Decline an assignment you were asked to complete',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) =>
        declineAssignment(
          parseParams(AssignmentParams, req).assignmentId,
          userId(),
          parseBody(ReasonBody, req).reason,
          new Date(),
        ),
    },
    {
      method: 'post',
      path: '/assignments/:assignmentId/start',
      summary: 'Open the return for an assignment, or resume the open one',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) =>
        startAssessment(parseParams(AssignmentParams, req).assignmentId, userId(), new Date()),
    },
    {
      method: 'get',
      path: '/worklist',
      summary: 'Everything the calling assessor has been asked to do',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) => worklist(userId(), parseQuery(WorklistQuery, req), new Date()),
    },
    {
      method: 'get',
      path: '/completion/:cycleId/:acoOrgId',
      summary: 'How far a terminal has got through a cycle',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => {
        const { cycleId, acoOrgId } = parseParams(CompletionParams, req);
        const { participationId } = parseQuery(CompletionQuery, req);
        return completionFor(cycleId, acoOrgId, participationId ?? null);
      },
    },
    {
      method: 'get',
      path: '/submissions/:assessmentId',
      summary: 'A submitted return, read by whoever runs the cycle',
      policy: { requiredCapability: ASSESSMENTS_MANAGE, tenancy: 'ORG' },
      handler: (req) => readSubmission(parseParams(AssessmentParams, req).assessmentId),
    },
    {
      method: 'get',
      path: '/:assessmentId',
      summary: 'The calling assessor own return',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) => readAssessment(parseParams(AssessmentParams, req).assessmentId, userId()),
    },
    {
      method: 'get',
      path: '/:assessmentId/form',
      summary: 'The questions this return is answered against',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) => readAssessmentForm(parseParams(AssessmentParams, req).assessmentId, userId()),
    },
    {
      method: 'get',
      path: '/:assessmentId/readiness',
      summary: 'What is still standing between this return and a submission',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) => readReadiness(parseParams(AssessmentParams, req).assessmentId, userId()),
    },
    {
      method: 'patch',
      path: '/:assessmentId/answers',
      summary: 'Autosave a batch of answer changes',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) =>
        patchAnswers(
          parseParams(AssessmentParams, req).assessmentId,
          userId(),
          parseBody(AnswerPatch, req).ops,
          new Date(),
        ),
    },
    {
      method: 'post',
      path: '/:assessmentId/submit',
      summary: 'Submit a return',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) =>
        submitAssessment(parseParams(AssessmentParams, req).assessmentId, userId(), new Date()),
    },
    {
      method: 'post',
      path: '/:assessmentId/discard',
      summary: 'Abandon a draft',
      policy: { requiredCapability: ASSESSMENTS_RESPOND, tenancy: 'ORG' },
      handler: (req) => discardAssessment(parseParams(AssessmentParams, req).assessmentId, userId()),
    },
  ],
});
