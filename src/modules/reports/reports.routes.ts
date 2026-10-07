import { z } from 'zod';

import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import { airportReport } from './airport-report.service.js';
import { comparisonReport } from './comparison.service.js';
import { exportReport } from './export.service.js';
import { nationalReport } from './national-report.service.js';
import { operatorQuestions, operatorReport } from './operator-report.service.js';
import {
  airportReportQuery,
  airportReportResponse,
  comparisonQuery,
  comparisonResponse,
  exportQuery,
  nationalReportQuery,
  nationalReportResponse,
  operatorQuestionsResponse,
  operatorReportQuery,
  operatorReportResponse,
} from './reports.schemas.js';

const operatorParams = z.object({ acoId: idSchema });
const airportParams = z.object({ airportId: idSchema });

export const reportsRoutes = [
  route({
    method: 'get',
    path: '/operator/:acoId',
    policy: { kind: 'task', task: 'reports.operator' },
    summary: 'Operator dashboard: overall, comparison, distribution, categories, stakeholders, funnel, national airport table',
    params: operatorParams,
    query: operatorReportQuery,
    response: operatorReportResponse,
    handler: ({ ctx, params, query }) => operatorReport(ctx, params.acoId, query),
  }),
  route({
    method: 'get',
    path: '/operator/:acoId/questions',
    policy: { kind: 'task', task: 'reports.operator' },
    summary: 'Question-level table of an operator with comment counts',
    params: operatorParams,
    query: operatorReportQuery,
    response: operatorQuestionsResponse,
    handler: ({ ctx, params, query }) => operatorQuestions(ctx, params.acoId, query),
  }),
  route({
    method: 'get',
    path: '/airport/:airportId',
    policy: { kind: 'task', task: 'reports.airport' },
    summary: 'Airport roll-up: weighted score, operators table (platform/airport only), categories',
    params: airportParams,
    query: airportReportQuery,
    response: airportReportResponse,
    handler: ({ ctx, params, query }) => airportReport(ctx, params.airportId, query),
  }),
  route({
    method: 'get',
    path: '/national',
    policy: { kind: 'task', task: 'reports.national' },
    summary: 'National view: airports ranked, operators ranked, category averages, participation funnel',
    query: nationalReportQuery,
    response: nationalReportResponse,
    handler: ({ ctx, query }) => nationalReport(ctx, query),
  }),
  route({
    method: 'get',
    path: '/comparison',
    policy: { kind: 'task', task: 'reports.operator' },
    summary: 'One operator side by side across cycles, per level',
    query: comparisonQuery,
    response: comparisonResponse,
    handler: ({ ctx, query }) => comparisonReport(ctx, query),
  }),
  route({
    method: 'get',
    path: '/export',
    policy: { kind: 'session' },
    summary: 'CSV of the operator, airport or national report; the task of the chosen scope is required',
    query: exportQuery,
    handler: async ({ ctx, query, res }) => {
      const { fileName, contentType, csv } = await exportReport(ctx, query);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.status(200).send(csv);
      return undefined;
    },
  }),
];
