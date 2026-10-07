// Bulk import (ARCHITECTURE §6 customers/import, §5 `customer_imports`):
// validate stores what the operator reviewed; commit replays it in one
// transaction and never runs twice.
import type { AnyBulkWriteOperation } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { audit } from '../audit/audit.service.js';

import { CustomerImportModel, type CustomerImportDoc } from './customer-imports.model.js';
import { CustomerModel, type CustomerDoc } from './customers.model.js';
import type { ImportCommitDto, ImportValidationDto } from './customers.schemas.js';
import { customerScopeFilter, requireAcoTarget, requireOperatorTarget, type AcoTarget } from './customers.scope.js';
import { emailsByAco } from './customers.service.js';
import { customerCsvTemplate } from './domain/csvTemplate.js';
import { validateCustomerCsv, type CustomerCsvPreviewRow } from './domain/csvValidate.js';

export const TEMPLATE_FILE_NAME = 'customers-template.csv';
export const DEFAULT_IMPORT_FILE_NAME = 'customers.csv';

/** The downloadable template: the header row and two example rows. */
export function customerImportTemplate(): string {
  return customerCsvTemplate({ sampleRows: 2 });
}

export interface ValidateImportInput {
  csv: string;
  fileName: string;
  /** PLATFORM names the operator; an ACO user may only name its own. */
  acoId?: string | undefined;
}

function toValidationDto(doc: CustomerImportDoc, preview: CustomerCsvPreviewRow[]): ImportValidationDto {
  return {
    importId: idString(doc._id),
    acoId: idString(doc.acoId),
    fileName: doc.fileName,
    status: doc.status,
    rows: doc.rows,
    accepted: doc.accepted,
    rejected: doc.rejected,
    errors: doc.errors.map((error) => ({ ...error })),
    preview: preview.map((row) => ({ row: row.row, action: row.action, data: { ...row.data }, errors: row.errors.map((e) => ({ ...e })) })),
    headers: { matched: { ...doc.headers.matched }, ignored: [...doc.headers.ignored], missing: [...doc.headers.missing] },
  };
}

function toCommitDto(doc: CustomerImportDoc): ImportCommitDto {
  return {
    importId: idString(doc._id),
    acoId: idString(doc.acoId),
    fileName: doc.fileName,
    status: doc.status,
    rows: doc.rows,
    accepted: doc.accepted,
    rejected: doc.rejected,
    created: doc.result?.created ?? 0,
    updated: doc.result?.updated ?? 0,
    committedAt: doc.committedAt?.toISOString() ?? null,
  };
}

/**
 * POST /customers/import/validate: runs the domain validation against the
 * operator's existing e-mails and stores the outcome (accepted rows included)
 * as a VALIDATED import, whether or not anything was accepted, so the review
 * screen always has a record to show.
 */
export async function validateImport(ctx: RequestContext, input: ValidateImportInput): Promise<ImportValidationDto> {
  const target = await requireAcoTarget(ctx, input.acoId);
  const validation = validateCustomerCsv(input.csv, { existingEmails: await emailsByAco(idString(target.acoId)) });
  const created = (
    await CustomerImportModel.create({
      acoId: target.acoId,
      fileName: input.fileName,
      rows: validation.rows,
      accepted: validation.accepted,
      rejected: validation.rejected,
      errors: validation.errors,
      status: 'VALIDATED',
      createdBy: toId(ctx.user.id),
      records: validation.records,
      headers: validation.headers,
      result: null,
      committedAt: null,
      committedBy: null,
    })
  ).toObject();
  return toValidationDto(created, validation.preview);
}

/** One upsert per accepted row, keyed on (operator, e-mail); the file's values win, status is left alone on update. */
function commitOperations(doc: CustomerImportDoc, target: AcoTarget): AnyBulkWriteOperation<CustomerDoc>[] {
  return doc.records.map((record) => ({
    updateOne: {
      filter: { acoId: target.acoId, email: record.data.email },
      update: {
        $set: {
          airportId: target.airportId,
          name: record.data.name,
          contactPerson: record.data.contactPerson,
          phone: record.data.phone,
          type: record.data.type,
          surveyType: record.data.surveyType,
          tags: record.data.tags,
          importBatchId: doc._id,
        },
        $setOnInsert: { acoId: target.acoId, email: record.data.email, status: 'ACTIVE', lastSampledCycleId: null },
      },
      upsert: true,
    },
  }));
}

/**
 * POST /customers/import/:importId/commit: in one transaction claims the
 * VALIDATED import (so a second commit is a 409), creates or updates every
 * accepted row and records the counts; then audits `customer.imported`.
 * An import of another operator is 404.
 */
export async function commitImport(ctx: RequestContext, importId: string, acoId?: string): Promise<ImportCommitDto> {
  const doc = await CustomerImportModel.findOne(
    and<CustomerImportDoc>(customerScopeFilter(ctx, acoId), { _id: toId(importId, 'importId') }),
  ).lean<CustomerImportDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Import not found');
  if (doc.status === 'COMMITTED') {
    throw new AppError('CONFLICT', 'This import has already been committed', {
      importId: idString(doc._id),
      committedAt: doc.committedAt?.toISOString() ?? null,
    });
  }
  if (doc.records.length === 0) {
    throw new AppError('PRECONDITION_FAILED', 'Nothing to commit: the file had no accepted rows', { rejected: doc.rejected });
  }
  const target = await requireOperatorTarget(doc.acoId);

  const committed = await withTransaction(async (session) => {
    const now = new Date();
    const claimed = await CustomerImportModel.findOneAndUpdate(
      { _id: doc._id, status: 'VALIDATED' },
      { $set: { status: 'COMMITTED', committedAt: now, committedBy: toId(ctx.user.id) } },
      { session, new: true },
    ).lean<CustomerImportDoc>();
    if (!claimed) throw new AppError('CONFLICT', 'This import has already been committed', { importId: idString(doc._id) });
    const bulk = await CustomerModel.bulkWrite(commitOperations(claimed, target), { session, ordered: true });
    const result = { created: bulk.upsertedCount, updated: bulk.matchedCount };
    const final = await CustomerImportModel.findOneAndUpdate({ _id: doc._id }, { $set: { result } }, { session, new: true }).lean<CustomerImportDoc>();
    if (!final) throw new AppError('INTERNAL', 'Import vanished during commit');
    return final;
  });

  const dto = toCommitDto(committed);
  await audit(ctx, {
    action: 'customer.imported',
    entity: 'customer_import',
    entityId: dto.importId,
    after: { fileName: dto.fileName, rows: dto.rows, accepted: dto.accepted, rejected: dto.rejected, created: dto.created, updated: dto.updated },
    orgId: dto.acoId,
  });
  return dto;
}
