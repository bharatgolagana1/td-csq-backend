import { z } from 'zod';

import { route } from '../../core/http.js';

import {
  assessmentDetailResponse,
  assessmentListQuery,
  assessmentParams,
  assessmentResponse,
  exportQuery,
  historyRowResponse,
  patchAnswersBody,
  patchAnswersResponse,
  selfAssessmentResponse,
  selfParams,
} from './assessments.schemas.js';
import {
  exportAssessmentsCsv,
  getAssessment,
  getSelfAssessment,
  listAssessments,
  patchSelfAnswers,
  submitSelf,
} from './assessments.service.js';

// `/export` and `/self/…` are declared before `/:id` so Express never reads them as an id.
export const assessmentsRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'assessments.view' },
    summary: 'Assessment history: one row per assessment with masked assessor identity and own score',
    query: assessmentListQuery,
    response: z.array(historyRowResponse),
    handler: ({ ctx, query }) => listAssessments(ctx, query),
  }),
  route({
    method: 'get',
    path: '/export',
    policy: { kind: 'task', task: 'assessments.view' },
    summary: 'CSV of a cycle’s assessments, one row per assessment and question',
    query: exportQuery,
    handler: async ({ ctx, query, res }) => {
      const { fileName, csv } = await exportAssessmentsCsv(ctx, query);
      res.status(200).type('text/csv').attachment(fileName).send(csv);
      return undefined;
    },
  }),

  route({
    method: 'get',
    path: '/self/:cycleId/:surveyType',
    policy: { kind: 'task', task: 'assessments.self' },
    summary: 'The operator’s self-assessment for a cycle and survey type (created on first access)',
    params: selfParams,
    response: selfAssessmentResponse,
    handler: ({ ctx, params }) => getSelfAssessment(ctx, params.cycleId, params.surveyType),
  }),
  route({
    method: 'patch',
    path: '/self/:cycleId/:surveyType/answers',
    policy: { kind: 'task', task: 'assessments.self' },
    summary: 'Autosave self-assessment answers (merge by question); returns progress',
    params: selfParams,
    body: patchAnswersBody,
    response: patchAnswersResponse,
    handler: ({ ctx, params, body }) => patchSelfAnswers(ctx, params.cycleId, params.surveyType, body.answers),
  }),
  route({
    method: 'post',
    path: '/self/:cycleId/:surveyType/submit',
    policy: { kind: 'task', task: 'assessments.self' },
    summary: 'Submit the self-assessment (every question answered); locks it',
    params: selfParams,
    response: assessmentResponse,
    handler: ({ ctx, params }) => submitSelf(ctx, params.cycleId, params.surveyType),
  }),

  route({
    method: 'get',
    path: '/:id',
    policy: { kind: 'task', task: 'assessments.view' },
    summary: 'Read-only return: every form question with its answer',
    params: assessmentParams,
    response: assessmentDetailResponse,
    handler: ({ ctx, params }) => getAssessment(ctx, params.id),
  }),
];
