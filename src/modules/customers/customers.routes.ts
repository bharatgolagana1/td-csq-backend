import express, { type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { AppError } from '../../core/errors.js';
import { route } from '../../core/http.js';
import { idSchema } from '../../core/ids.js';

import { commitImport, customerImportTemplate, DEFAULT_IMPORT_FILE_NAME, TEMPLATE_FILE_NAME, validateImport } from './customer-imports.service.js';
import {
  acoScopeQuery,
  createCustomerBody,
  customerListQuery,
  customerResponse,
  importCommitResponse,
  importParams,
  importValidateQuery,
  importValidationResponse,
  patchCustomerBody,
} from './customers.schemas.js';
import {
  createCustomer,
  deactivateCustomer,
  getCustomerInScope,
  listCustomers,
  reactivateCustomer,
  updateCustomer,
} from './customers.service.js';

const customerParams = z.object({ id: idSchema });

/** Accepts the CSV either as a multipart `file` field or as a raw `text/csv` body (same as airports). */
const csvUpload = [
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
];

function csvFromRequest(req: Request): { csv: string; fileName: string | null } {
  if (req.file) return { csv: req.file.buffer.toString('utf8'), fileName: req.file.originalname || null };
  return { csv: typeof req.body === 'string' ? req.body : '', fileName: null };
}

export const customersRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'customers.view' },
    summary: 'List the operator directory (filters type, surveyType, status, tag; q over name, e-mail, contact)',
    query: customerListQuery,
    response: z.array(customerResponse),
    handler: ({ ctx, query }) => listCustomers(ctx, query),
  }),
  route({
    method: 'post',
    path: '/',
    policy: { kind: 'task', task: 'customers.manage' },
    summary: 'Add one customer (PLATFORM passes acoId)',
    body: createCustomerBody,
    response: customerResponse,
    status: 201,
    handler: ({ ctx, body }) => createCustomer(ctx, body),
  }),

  route({
    method: 'get',
    path: '/import/template',
    policy: { kind: 'task', task: 'customers.view' },
    summary: 'Download the bulk-import CSV template with two example rows',
    handler: ({ res }) => {
      res.attachment(TEMPLATE_FILE_NAME).type('text/csv').send(customerImportTemplate());
    },
  }),
  route({
    method: 'post',
    path: '/import/validate',
    policy: { kind: 'task', task: 'customers.manage' },
    summary: 'Validate a customer CSV (multipart "file" or text/csv body) and store it for commit',
    before: csvUpload,
    query: importValidateQuery,
    response: importValidationResponse,
    status: 201,
    handler: ({ ctx, query, req }) => {
      const { csv, fileName } = csvFromRequest(req);
      if (!csv.trim()) throw new AppError('VALIDATION', 'Provide a CSV file (multipart "file") or a text/csv body');
      return validateImport(ctx, { csv, fileName: query.fileName ?? fileName ?? DEFAULT_IMPORT_FILE_NAME, acoId: query.acoId });
    },
  }),
  route({
    method: 'post',
    path: '/import/:importId/commit',
    policy: { kind: 'task', task: 'customers.manage' },
    summary: 'Create / update customers from a validated import (transaction; 409 when already committed)',
    params: importParams,
    query: acoScopeQuery,
    response: importCommitResponse,
    handler: ({ ctx, params, query }) => commitImport(ctx, params.importId, query.acoId),
  }),

  route({
    method: 'get',
    path: '/:id',
    policy: { kind: 'task', task: 'customers.view' },
    params: customerParams,
    response: customerResponse,
    handler: ({ ctx, params }) => getCustomerInScope(ctx, params.id),
  }),
  route({
    method: 'patch',
    path: '/:id',
    policy: { kind: 'task', task: 'customers.manage' },
    params: customerParams,
    body: patchCustomerBody,
    response: customerResponse,
    handler: ({ ctx, params, body }) => updateCustomer(ctx, params.id, body),
  }),
  route({
    method: 'post',
    path: '/:id/deactivate',
    policy: { kind: 'task', task: 'customers.manage' },
    params: customerParams,
    response: customerResponse,
    handler: ({ ctx, params }) => deactivateCustomer(ctx, params.id),
  }),
  route({
    method: 'post',
    path: '/:id/reactivate',
    policy: { kind: 'task', task: 'customers.manage' },
    params: customerParams,
    response: customerResponse,
    handler: ({ ctx, params }) => reactivateCustomer(ctx, params.id),
  }),
];
