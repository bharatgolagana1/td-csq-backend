import type { AnyBulkWriteOperation } from 'mongoose';
import type { FormScope } from '@csq/contracts';
import { TenantRepo } from '../../kernel/tenancy.js';
import { fail, notFound } from '../../kernel/errors.js';
import { newId } from '../../kernel/ids.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import { appendAudit } from './sampling.audit.js';
import { inTransaction } from './sampling.db.js';
import { loadSamplingSettings } from './sampling.policy.js';
import {
  ContactImportModel,
  CustomerContactModel,
  type ContactImportDoc,
  type CustomerContactDoc,
  type ImportRowDoc,
} from './sampling.models.js';
import {
  foldKey,
  normaliseEmail,
  normalisePhone,
  parseCsv,
  sanitiseImportCell,
} from './sampling.sanitise.js';
import {
  CUSTOMER_TYPES,
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type CustomerType,
  type ImportColumn,
  type ImportMode,
  type ImportRowProblem,
  type ImportView,
  type ValidateImport,
} from './sampling.contracts.js';

/**
 * Bulk import in two phases: validate, look at the report, then commit.
 *
 * The phases are separate because an operator pasting four hundred rows needs
 * to see what will happen before anything is written, and because the commit
 * has to survive a dropped connection. Committing the same import twice writes
 * the directory once.
 */

const imports = new TenantRepo<ContactImportDoc>(ContactImportModel);
const contacts = new TenantRepo<CustomerContactDoc>(CustomerContactModel);

const REQUIRED_COLUMNS: readonly ImportColumn[] = ['name', 'company', 'email', 'customerType', 'formScope'];

/**
 * status is exported for the operator's benefit and deliberately ignored on the
 * way back in. A bounce or a suppression is the system's record of what
 * happened to an address; a spreadsheet must not be able to clear it.
 */
const IGNORED_COLUMNS: readonly string[] = ['status', 'id'];

interface RawRow {
  readonly line: number;
  readonly cells: Readonly<Partial<Record<ImportColumn, string>>>;
  readonly sanitised: boolean;
}

function rowsFromObjects(rows: ReadonlyArray<Partial<Record<ImportColumn, string>>>): RawRow[] {
  return rows.map((row, index) => {
    const cells: Partial<Record<ImportColumn, string>> = {};
    let sanitised = false;
    for (const column of IMPORT_COLUMNS) {
      const raw = row[column];
      if (raw === undefined) continue;
      const cell = sanitiseImportCell(raw);
      cells[column] = cell.value;
      sanitised = sanitised || cell.changed;
    }
    return { line: index + 1, cells, sanitised };
  });
}

function rowsFromCsv(csv: string): RawRow[] {
  const parsed = parseCsv(csv);
  if (parsed.header.length === 0) {
    throw fail('VALIDATION_FAILED', 'The file has no header row', [
      { path: 'csv', message: `expected a header row of ${IMPORT_COLUMNS.join(', ')}` },
    ]);
  }

  const known = new Set<string>(IMPORT_COLUMNS);
  const mapping: Array<ImportColumn | null> = [];
  const problems: Array<{ path: string; message: string }> = [];

  parsed.header.forEach((label, index) => {
    const name = foldKey(label).replace(/[\s_-]/g, '');
    const match = IMPORT_COLUMNS.find((column) => column.toLowerCase() === name);
    if (match !== undefined && known.has(match)) {
      mapping[index] = match;
      return;
    }
    mapping[index] = null;
    if (!IGNORED_COLUMNS.some((ignored) => ignored === name)) {
      problems.push({ path: `csv.header[${index}]`, message: `${label} is not a column this import understands` });
    }
  });

  for (const column of REQUIRED_COLUMNS) {
    if (!mapping.includes(column)) {
      problems.push({ path: 'csv.header', message: `the ${column} column is missing` });
    }
  }
  if (problems.length > 0) throw fail('VALIDATION_FAILED', 'The file header is not usable', problems);

  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw fail('VALIDATION_FAILED', 'The file is too large', [
      { path: 'csv', message: `at most ${MAX_IMPORT_ROWS} rows in one import, found ${parsed.rows.length}` },
    ]);
  }

  return parsed.rows.map((row, index) => {
    const cells: Partial<Record<ImportColumn, string>> = {};
    let sanitised = false;
    row.forEach((value, columnIndex) => {
      const column = mapping[columnIndex];
      if (column === null || column === undefined) return;
      const cell = sanitiseImportCell(value);
      cells[column] = cell.value;
      sanitised = sanitised || cell.changed;
    });
    // the header is line 1, so the operator's line numbers match ours
    return { line: index + 2, cells, sanitised };
  });
}

function parseCustomerType(raw: string | undefined): CustomerType | null {
  if (raw === undefined) return null;
  const folded = foldKey(raw).replace(/[\s-]/g, '_').toUpperCase();
  return CUSTOMER_TYPES.find((type) => type === folded) ?? null;
}

function parseFormScope(raw: string | undefined): FormScope | null {
  if (raw === undefined) return null;
  const folded = foldKey(raw).toUpperCase();
  return folded === 'INTERNATIONAL' || folded === 'DOMESTIC' ? folded : null;
}

interface RowProblem {
  column: string;
  code: ImportRowProblem;
  message: string;
}

export async function validateImport(input: ValidateImport): Promise<ImportView> {
  const raw = input.csv !== undefined ? rowsFromCsv(input.csv) : rowsFromObjects(input.rows ?? []);
  if (raw.length === 0) {
    throw fail('VALIDATION_FAILED', 'The import has no rows', [{ path: 'rows', message: 'at least one row is required' }]);
  }

  const settings = await loadSamplingSettings();
  const seen = new Map<string, number>();
  const draft: ImportRowDoc[] = [];

  for (const row of raw) {
    const problems: RowProblem[] = [];
    const name = row.cells.name ?? '';
    const company = row.cells.company ?? '';
    const emailRaw = row.cells.email ?? '';
    const phoneRaw = row.cells.phone ?? '';

    if (name.length === 0) problems.push({ column: 'name', code: 'MISSING_REQUIRED', message: 'a contact name is required' });
    if (name.length > 200) problems.push({ column: 'name', code: 'TOO_LONG', message: 'at most 200 characters' });
    if (company.length === 0) problems.push({ column: 'company', code: 'MISSING_REQUIRED', message: 'a company is required' });
    if (company.length > 200) problems.push({ column: 'company', code: 'TOO_LONG', message: 'at most 200 characters' });

    const emailLower = emailRaw.length === 0 ? null : normaliseEmail(emailRaw);
    if (emailRaw.length === 0) {
      problems.push({ column: 'email', code: 'MISSING_REQUIRED', message: 'an email address is required' });
    } else if (emailLower === null) {
      problems.push({ column: 'email', code: 'INVALID_EMAIL', message: `${emailRaw} is not an email address` });
    }

    const phoneE164 = phoneRaw.length === 0 ? null : normalisePhone(phoneRaw, settings.defaultDialCode);
    if (phoneRaw.length > 0 && phoneE164 === null) {
      problems.push({ column: 'phone', code: 'INVALID_PHONE', message: `${phoneRaw} is not reachable in E.164` });
    }

    const customerType = parseCustomerType(row.cells.customerType);
    if (customerType === null) {
      problems.push({
        column: 'customerType',
        code: row.cells.customerType === undefined || row.cells.customerType.length === 0 ? 'MISSING_REQUIRED' : 'UNKNOWN_CUSTOMER_TYPE',
        message: `one of ${CUSTOMER_TYPES.join(', ')}`,
      });
    }

    const formScope = parseFormScope(row.cells.formScope);
    if (formScope === null) {
      problems.push({
        column: 'formScope',
        code: row.cells.formScope === undefined || row.cells.formScope.length === 0 ? 'MISSING_REQUIRED' : 'UNKNOWN_FORM_SCOPE',
        message: 'one of INTERNATIONAL, DOMESTIC',
      });
    }

    if (emailLower !== null) {
      const first = seen.get(emailLower);
      if (first !== undefined) {
        problems.push({
          column: 'email',
          code: 'DUPLICATE_IN_FILE',
          message: `the same address is already on line ${first}`,
        });
      } else {
        seen.set(emailLower, row.line);
      }
    }

    draft.push({
      line: row.line,
      outcome: problems.length > 0 ? 'REJECT' : 'CREATE',
      problems,
      sanitised: row.sanitised,
      name: name.length > 0 ? name : null,
      company: company.length > 0 ? company : null,
      email: emailRaw.length > 0 ? emailRaw : null,
      emailLower,
      phoneE164,
      customerType,
      formScope,
      existingContactId: null,
    });
  }

  await markExisting(draft, input.mode);

  const counts = {
    total: draft.length,
    create: draft.filter((row) => row.outcome === 'CREATE').length,
    update: draft.filter((row) => row.outcome === 'UPDATE').length,
    skip: draft.filter((row) => row.outcome === 'SKIP').length,
    reject: draft.filter((row) => row.outcome === 'REJECT').length,
    sanitised: draft.filter((row) => row.sanitised).length,
  };

  const created = await imports.create({
    state: 'VALIDATED',
    mode: input.mode,
    fileName: input.fileName,
    createdBy: requirePrincipal().userId,
    rows: draft,
    counts,
    committedAt: null,
  });

  return toImportView(created.toObject());
}

/** Decides create from update, which is also what makes CREATE_ONLY mean anything. */
async function markExisting(draft: ImportRowDoc[], mode: ImportMode): Promise<void> {
  const addresses = draft.filter((row) => row.outcome === 'CREATE' && row.emailLower !== null).map((row) => row.emailLower);
  if (addresses.length === 0) return;

  const existing = await contacts
    .find({ emailLower: { $in: addresses } }, { _id: 1, emailLower: 1 })
    .lean()
    .exec();
  const byAddress = new Map(existing.map((row) => [row.emailLower, row._id]));

  for (const row of draft) {
    if (row.outcome !== 'CREATE' || row.emailLower === null) continue;
    const contactId = byAddress.get(row.emailLower);
    if (contactId === undefined) continue;

    row.existingContactId = contactId;
    if (mode === 'CREATE_ONLY') {
      row.outcome = 'SKIP';
      row.problems.push({
        column: 'email',
        code: 'ALREADY_ON_FILE',
        message: 'already in the directory, and this import was asked to create only',
      });
    } else {
      row.outcome = 'UPDATE';
    }
  }
}

function toImportView(doc: ContactImportDoc): ImportView {
  return {
    id: doc._id,
    state: doc.state,
    mode: doc.mode,
    fileName: doc.fileName,
    counts: { ...doc.counts },
    rows: doc.rows.map((row) => ({
      line: row.line,
      outcome: row.outcome,
      email: row.email,
      company: row.company,
      problems: row.problems.map((problem) => ({ ...problem })),
      sanitised: row.sanitised,
    })),
    createdAt: doc.createdAt.toISOString(),
    committedAt: doc.committedAt === null ? null : doc.committedAt.toISOString(),
  };
}

export async function readImport(importId: string): Promise<ImportView> {
  const doc = await imports.findById(importId).lean().exec();
  if (!doc) throw notFound('No such import');
  return toImportView(doc);
}

/**
 * Idempotent by construction: the state flip from VALIDATED to COMMITTED is the
 * claim, it happens inside the same transaction as the writes, and a second
 * caller either loses the claim or collides on the document and retries into a
 * state where there is nothing left to do.
 */
export async function commitImport(importId: string): Promise<ImportView> {
  const existing = await imports.findById(importId).lean().exec();
  if (!existing) throw notFound('No such import');
  if (existing.state === 'COMMITTED') return toImportView(existing);

  const committed = await inTransaction(async (session) => {
    const claimed = await imports
      .findOneAndUpdate(
        { _id: importId, state: 'VALIDATED' },
        { $set: { state: 'COMMITTED', committedAt: new Date() } },
        { session },
      )
      .lean()
      .exec();

    if (!claimed) {
      const settled = await imports.findById(importId).session(session).lean().exec();
      if (!settled) throw notFound('No such import');
      return settled;
    }

    const operations = writesFor(claimed);
    if (operations.length > 0) {
      await CustomerContactModel.bulkWrite(operations, { session });
    }

    await appendAudit(
      [
        {
          action: 'CONTACTS_IMPORTED',
          subjectType: 'IMPORT',
          subjectId: importId,
          detail: {
            mode: claimed.mode,
            total: claimed.counts.total,
            created: claimed.counts.create,
            updated: claimed.counts.update,
            skipped: claimed.counts.skip,
            rejected: claimed.counts.reject,
            fileName: claimed.fileName ?? '',
          },
        },
      ],
      session,
    );

    return claimed;
  });

  return toImportView(committed);
}

function writesFor(doc: ContactImportDoc): Array<AnyBulkWriteOperation<CustomerContactDoc>> {
  const operations: Array<AnyBulkWriteOperation<CustomerContactDoc>> = [];

  for (const row of doc.rows) {
    if (row.outcome !== 'CREATE' && row.outcome !== 'UPDATE') continue;
    if (row.emailLower === null || row.name === null || row.company === null || row.email === null) continue;
    if (row.customerType === null || row.formScope === null) continue;

    // status is never in $set: a contact that bounced or opted out between the
    // validate and the commit stays that way
    const onInsert = {
      _id: newId(),
      emailLower: row.emailLower,
      status: 'ACTIVE' as const,
      source: 'IMPORT' as const,
    };
    const mutable = {
      name: row.name,
      company: row.company,
      companyKey: foldKey(row.company),
      email: row.email,
      phoneE164: row.phoneE164,
      customerType: row.customerType,
      formScope: row.formScope,
      lastImportId: doc._id,
    };

    operations.push({
      updateOne: {
        filter: { emailLower: row.emailLower },
        // CREATE_ONLY writes nothing to a row that already exists, which is both
        // what the mode means and what makes the write safe to replay
        update: doc.mode === 'CREATE_ONLY' ? { $setOnInsert: { ...onInsert, ...mutable } } : { $set: mutable, $setOnInsert: onInsert },
        upsert: true,
      },
    });
  }
  return operations;
}
