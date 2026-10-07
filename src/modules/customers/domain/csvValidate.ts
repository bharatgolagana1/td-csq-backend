/**
 * Validation of an uploaded customer CSV (ARCHITECTURE.md §6
 * `POST /customers/import/validate`, §5 `customer_imports`). Pure: parse,
 * normalise, find duplicates, decide CREATE/UPDATE per row. The commit is
 * the service's transaction.
 *
 * Row numbers are spreadsheet line numbers: the header is row 1, the first
 * data row is row 2. File-level problems use row 0.
 */
import Papa from 'papaparse';

import { mapHeaders, type HeaderMap } from './csvHeaders.js';
import { CUSTOMER_CSV_MAX_ROWS, type CustomerCsvField, type CustomerSurveyType, type CustomerType } from './csvTemplate.js';
import {
  normaliseContactPerson,
  normaliseCustomerType,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  normaliseSurveyType,
  normaliseTags,
  type Normalised,
} from './normalise.js';

export interface CustomerCsvRecord {
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  type: CustomerType;
  surveyType: CustomerSurveyType;
  tags: string[];
}

export interface CustomerCsvError {
  row: number;
  field: CustomerCsvField | 'file' | 'header';
  message: string;
}

export type CustomerCsvAction = 'CREATE' | 'UPDATE';

export interface AcceptedCustomerRow {
  row: number;
  action: CustomerCsvAction;
  data: CustomerCsvRecord;
}

export interface CustomerCsvPreviewRow {
  row: number;
  action: CustomerCsvAction | 'REJECT';
  /** Normalised values where they validated; raw text otherwise. */
  data: Partial<Record<CustomerCsvField, string | string[]>>;
  errors: CustomerCsvError[];
}

export interface CustomerCsvValidation {
  /** Data rows in the file (blank lines excluded). */
  rows: number;
  accepted: number;
  rejected: number;
  errors: CustomerCsvError[];
  preview: CustomerCsvPreviewRow[];
  /** Every accepted row, for the commit. */
  records: AcceptedCustomerRow[];
  headers: Pick<HeaderMap, 'matched' | 'ignored' | 'missing'>;
}

export interface ValidateCustomerCsvOptions {
  /** E-mails already in the operator's directory; a match makes the row an UPDATE. */
  existingEmails: Iterable<string>;
  /** Rows shown in `preview`; default 20. */
  previewLimit?: number;
  /** Default 5,000. */
  maxRows?: number;
}

const HEADER_ROW = 1;

function emptyResult(errors: CustomerCsvError[], rows = 0): CustomerCsvValidation {
  return { rows, accepted: 0, rejected: rows, errors, preview: [], records: [], headers: { matched: {}, ignored: [], missing: [] } };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

function cell(cells: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (cells[index] ?? '');
}

interface RowOutcome {
  record: CustomerCsvRecord | null;
  data: CustomerCsvPreviewRow['data'];
  errors: CustomerCsvError[];
}

function validateRow(row: number, cells: readonly string[], headers: HeaderMap): RowOutcome {
  const errors: CustomerCsvError[] = [];
  const data: CustomerCsvPreviewRow['data'] = {};
  const take = <T extends string | string[]>(field: CustomerCsvField, result: Normalised<T>, raw: string): T | null => {
    if (result.ok) {
      data[field] = result.value;
      return result.value;
    }
    data[field] = raw.trim();
    errors.push({ row, field, message: result.message });
    return null;
  };

  const rawName = cell(cells, headers.columns.name);
  const rawContact = cell(cells, headers.columns.contactPerson);
  const rawEmail = cell(cells, headers.columns.email);
  const rawPhone = cell(cells, headers.columns.phone);
  const rawType = cell(cells, headers.columns.type);
  const rawSurvey = cell(cells, headers.columns.surveyType);
  const rawTags = cell(cells, headers.columns.tags);

  const name = take('name', normaliseName(rawName), rawName);
  const contact = take('contactPerson', normaliseContactPerson(rawContact), rawContact);
  const email = take('email', normaliseEmail(rawEmail), rawEmail);
  const phone = take('phone', normalisePhone(rawPhone), rawPhone);
  const type = take('type', normaliseCustomerType(rawType), rawType);
  const surveyType = take('surveyType', normaliseSurveyType(rawSurvey), rawSurvey);
  const tags = take('tags', normaliseTags(rawTags), rawTags);

  if (name === null || contact === null || email === null || phone === null || type === null || surveyType === null || tags === null) {
    return { record: null, data, errors };
  }
  // A sole trader often leaves the contact blank: the organisation name stands in.
  const contactPerson = contact === '' ? name : contact;
  data.contactPerson = contactPerson;
  return { record: { name, contactPerson, email, phone, type, surveyType, tags }, data, errors };
}

export function validateCustomerCsv(text: string, options: ValidateCustomerCsvOptions): CustomerCsvValidation {
  const previewLimit = options.previewLimit ?? 20;
  const maxRows = options.maxRows ?? CUSTOMER_CSV_MAX_ROWS;
  const body = stripBom(text);
  if (body.trim() === '') return emptyResult([{ row: 0, field: 'file', message: 'The file is empty' }]);

  const parsed = Papa.parse<string[]>(body, { header: false, skipEmptyLines: false, dynamicTyping: false });
  const lines: string[][] = parsed.data;

  const headerCells = lines[0];
  if (headerCells === undefined || isBlank(headerCells)) {
    return emptyResult([{ row: 0, field: 'header', message: 'The first row must contain the column headers' }]);
  }
  const headers = mapHeaders(headerCells);
  if (headers.missing.length > 0) {
    return {
      ...emptyResult([{ row: HEADER_ROW, field: 'header', message: `Missing column(s): ${headers.missing.join(', ')}` }]),
      headers: { matched: headers.matched, ignored: headers.ignored, missing: headers.missing },
    };
  }

  const dataLines: { row: number; cells: string[] }[] = [];
  lines.forEach((cells, index) => {
    if (index === 0 || isBlank(cells)) return;
    dataLines.push({ row: index + 1, cells });
  });
  if (dataLines.length === 0) {
    return { ...emptyResult([{ row: 0, field: 'file', message: 'No data rows under the header' }]), headers };
  }
  if (dataLines.length > maxRows) {
    return {
      ...emptyResult(
        [
          {
            row: 0,
            field: 'file',
            message: `Too many rows: ${dataLines.length.toLocaleString('en-IN')} (maximum ${maxRows.toLocaleString('en-IN')})`,
          },
        ],
        dataLines.length,
      ),
      headers,
    };
  }

  const existing = new Set<string>();
  for (const email of options.existingEmails) existing.add(email.trim().toLowerCase());

  const seenEmails = new Map<string, number>();
  const errors: CustomerCsvError[] = [];
  const preview: CustomerCsvPreviewRow[] = [];
  const records: AcceptedCustomerRow[] = [];
  let rejected = 0;

  for (const { row, cells } of dataLines) {
    const outcome = validateRow(row, cells, headers);
    let record = outcome.record;
    if (record !== null) {
      const firstRow = seenEmails.get(record.email);
      if (firstRow !== undefined) {
        outcome.errors.push({ row, field: 'email', message: `Duplicate of row ${firstRow} (${record.email})` });
        record = null;
      } else {
        seenEmails.set(record.email, row);
      }
    }

    let action: CustomerCsvAction | 'REJECT';
    if (record === null) {
      action = 'REJECT';
      rejected += 1;
      errors.push(...outcome.errors);
    } else {
      action = existing.has(record.email) ? 'UPDATE' : 'CREATE';
      records.push({ row, action, data: record });
    }
    if (preview.length < previewLimit) preview.push({ row, action, data: outcome.data, errors: outcome.errors });
  }

  return {
    rows: dataLines.length,
    accepted: records.length,
    rejected,
    errors,
    preview,
    records,
    headers: { matched: headers.matched, ignored: headers.ignored, missing: headers.missing },
  };
}
