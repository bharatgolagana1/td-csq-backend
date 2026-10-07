import Papa from 'papaparse';

export type CsvCell = string | number | boolean | null | undefined;

/** `null`/`undefined` → empty cell; booleans → `true`/`false`; numbers as JSON prints them (2 dp means stay 2 dp). */
function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** One CSV document: a header row of `columns` then one line per row, in column order (RFC 4180 quoting, CRLF). */
export function toCsv(columns: readonly string[], rows: readonly Record<string, CsvCell>[]): string {
  return Papa.unparse({ fields: [...columns], data: rows.map((row) => columns.map((column) => cell(row[column]))) }, { newline: '\r\n' });
}

/** `csq-operator-CYC-2026-1-DOMESTIC.csv`: safe for a Content-Disposition filename. */
export function csvFileName(...parts: string[]): string {
  const safe = parts.map((part) => part.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')).filter((part) => part !== '');
  return `${['csq', ...safe].join('-')}.csv`;
}
