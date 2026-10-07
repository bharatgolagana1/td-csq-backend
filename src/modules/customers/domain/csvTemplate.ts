/**
 * The bulk-import template an operator downloads (REQUIREMENTS §7;
 * ARCHITECTURE.md §6 `GET /customers/import/template`).
 */
import Papa from 'papaparse';

export type CustomerType = 'FF' | 'CB';
export type CustomerSurveyType = 'DOMESTIC' | 'INTERNATIONAL' | 'BOTH';

export interface CustomerCsvColumn {
  key: CustomerCsvField;
  header: string;
  required: boolean;
  help: string;
}

export type CustomerCsvField = 'name' | 'contactPerson' | 'email' | 'phone' | 'type' | 'surveyType' | 'tags';

export const CUSTOMER_CSV_COLUMNS: readonly CustomerCsvColumn[] = [
  { key: 'name', header: 'Name', required: true, help: 'Organisation name of the freight forwarder or customs broker' },
  { key: 'contactPerson', header: 'Contact person', required: true, help: 'Who receives the survey' },
  { key: 'email', header: 'Email', required: true, help: 'One e-mail per customer; it identifies the customer on re-import' },
  { key: 'phone', header: 'Phone', required: true, help: '10-digit Indian mobile, or international with a leading +' },
  { key: 'type', header: 'Type', required: true, help: 'FF (freight forwarder) or CB (customs broker)' },
  { key: 'surveyType', header: 'Survey type', required: true, help: 'DOMESTIC, INTERNATIONAL or BOTH' },
  { key: 'tags', header: 'Tags', required: false, help: 'Optional labels separated by ;' },
];

export const CUSTOMER_CSV_HEADERS: readonly string[] = CUSTOMER_CSV_COLUMNS.map((column) => column.header);

export const CUSTOMER_CSV_MAX_ROWS = 5000;

/** A row as it appears in the file: one string per template column. */
export type CustomerCsvRow = Record<CustomerCsvField, string>;

const SAMPLE_CONTACTS = ['Asha Rao', 'Vikram Mehta', 'Priya Nair', 'Rahul Verma', 'Meera Iyer'];

/** Deterministic example rows (never real people), cycling FF/CB and the survey types. */
export function sampleCustomerRows(count = 3): CustomerCsvRow[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a whole number ≥ 0 (got ${count})`);
  const surveyTypes: CustomerSurveyType[] = ['DOMESTIC', 'INTERNATIONAL', 'BOTH'];
  const rows: CustomerCsvRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const type: CustomerType = index % 2 === 0 ? 'FF' : 'CB';
    const n = index + 1;
    rows.push({
      name: type === 'FF' ? `Sample Forwarder ${n} Pvt Ltd` : `Sample Customs Broker ${n}`,
      contactPerson: SAMPLE_CONTACTS[index % SAMPLE_CONTACTS.length] ?? 'Sample Contact',
      email: `customer${n}@example.com`,
      phone: `+9198765${String(n).padStart(5, '0')}`,
      type,
      surveyType: surveyTypes[index % surveyTypes.length] ?? 'DOMESTIC',
      tags: index % 2 === 0 ? 'sample;priority' : 'sample',
    });
  }
  return rows;
}

export interface TemplateOptions {
  /** Example rows to include under the header; default 3, 0 for a bare header. */
  sampleRows?: number;
}

/** The template as CSV text (CRLF line endings, as RFC 4180 and Excel expect). */
export function customerCsvTemplate(options: TemplateOptions = {}): string {
  const rows = sampleCustomerRows(options.sampleRows ?? 3).map((row) =>
    CUSTOMER_CSV_COLUMNS.map((column) => row[column.key]),
  );
  const csv = Papa.unparse({ fields: [...CUSTOMER_CSV_HEADERS], data: rows }, { newline: '\r\n' });
  return `${csv.replace(/(\r?\n)+$/, '')}\r\n`;
}
