import express from 'express';
import multer from 'multer';
import { z } from 'zod';

import { AppError } from '../../core/errors.js';
import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';
import { getMarketShare } from '../organisations/market-share.service.js';
import { listOperatorsAtAirport } from '../organisations/operators.service.js';

import {
  airportListQuery,
  airportResponse,
  createAirportBody,
  importResultResponse,
  patchAirportBody,
} from './airports.schemas.js';
import { createAirport, getAirport, importAirportsCsv, listAirports, updateAirport } from './airports.service.js';

const airportParams = z.object({ id: idSchema });

/** Accepts the CSV either as a multipart `file` field or as a raw `text/csv` body. */
const csvUpload = [
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
];

export const airportsRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'airports.view' },
    summary: 'List airports (filters active, region, state)',
    query: airportListQuery,
    response: z.array(airportResponse),
    handler: ({ query }) => listAirports(query),
  }),
  route({
    method: 'post',
    path: '/',
    policy: { kind: 'task', task: 'airports.manage' },
    body: createAirportBody,
    response: airportResponse,
    status: 201,
    handler: ({ ctx, body }) => createAirport(ctx, body),
  }),
  route({
    method: 'post',
    path: '/import',
    policy: { kind: 'task', task: 'airports.manage' },
    summary: 'Upsert airports from CSV (multipart "file" or text/csv body)',
    before: csvUpload,
    response: importResultResponse,
    handler: ({ ctx, req }) => {
      const csv = req.file ? req.file.buffer.toString('utf8') : typeof req.body === 'string' ? req.body : '';
      if (!csv.trim()) throw new AppError('VALIDATION', 'Provide a CSV file (multipart "file") or a text/csv body');
      return importAirportsCsv(ctx, csv);
    },
  }),
  route({
    method: 'get',
    path: '/:id',
    policy: { kind: 'task', task: 'airports.view' },
    summary: 'Airport with its operators and current market shares',
    params: airportParams,
    handler: async ({ ctx, params }) => {
      const airport = await getAirport(params.id);
      const [operators, marketShare] = await Promise.all([
        listOperatorsAtAirport(ctx, params.id),
        getMarketShare(ctx, params.id, null).catch((error: unknown) => {
          // Operators that do not belong to this airport cannot see its shares; the airport itself is still visible.
          if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
          throw error;
        }),
      ]);
      return { ...airport, operators, marketShare };
    },
  }),
  route({
    method: 'patch',
    path: '/:id',
    policy: { kind: 'task', task: 'airports.manage' },
    params: airportParams,
    body: patchAirportBody,
    response: airportResponse,
    handler: ({ ctx, params, body }) => updateAirport(ctx, params.id, body),
  }),
];
