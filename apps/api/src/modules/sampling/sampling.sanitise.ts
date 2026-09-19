/**
 * Spreadsheet safety, in both directions, plus the normalisers the directory
 * and the importer share so a contact typed into the form and the same contact
 * pasted into a spreadsheet land on identical stored values.
 *
 * A cell beginning with = + - @ or a control character is executed as a formula
 * by Excel, Numbers and Sheets. The two directions need different treatment and
 * getting them the same way round is the usual mistake:
 *
 *   inbound   strip the formula, but never mistake a real +91 phone number or a
 *             negative quantity for one, because deleting the caller's data is
 *             also a failure
 *   outbound  prefix with an apostrophe, which every spreadsheet reads as "this
 *             is text" and displays without it, so the value survives intact
 */

const FORMULA_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Anything a terminal would interpret, plus the characters that break a CSV row. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function looksNumeric(rest: string): boolean {
  const digits = rest.replace(/[\s().-]/g, '');
  return digits.length > 0 && /^[0-9]+$/.test(digits);
}

export interface SanitisedCell {
  readonly value: string;
  /** True when something was removed, so the import report can say so. */
  readonly changed: boolean;
}

export function sanitiseImportCell(raw: unknown): SanitisedCell {
  if (raw === null || raw === undefined) return { value: '', changed: false };
  const asText = typeof raw === 'string' ? raw : String(raw);

  const withoutControl = asText.replace(CONTROL, '');
  let value = withoutControl.replace(/\s+/g, ' ').trim();
  let changed = withoutControl !== asText;

  // a leading run, because =-=1+1 is still a formula after one character goes
  while (value.length > 0) {
    const head = value[0];
    if (head === undefined || !FORMULA_LEAD.has(head)) break;
    // +919812345678 and -1250 are data, not formulas
    if ((head === '+' || head === '-') && looksNumeric(value.slice(1))) break;
    value = value.slice(1).trimStart();
    changed = true;
  }

  return { value, changed };
}

/** Neutralises a value on the way out and quotes it for RFC 4180. */
export function escapeCsvCell(value: string): string {
  const head = value[0];
  const neutralised = head !== undefined && FORMULA_LEAD.has(head) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralised) || neutralised !== value
    ? `"${neutralised.replace(/"/g, '""')}"`
    : neutralised;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  // CRLF, because that is what every spreadsheet writes and some still expect
  return `${lines.join('\r\n')}\r\n`;
}

export interface ParsedCsv {
  readonly header: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

/**
 * RFC 4180 with the tolerances real files need: a byte order mark, bare LF line
 * endings, and a trailing newline. Written by hand because pulling a parser in
 * for six columns is a supply chain decision, not a convenience one.
 */
export function parseCsv(text: string): ParsedCsv {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // a line that is one empty field is a blank line, not a row of one column
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== '' || row.length > 0) endRow();

  const [header = [], ...body] = rows;
  return { header, rows: body };
}

export function normaliseEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return null;
  // one @, something either side, a dot in the domain, no whitespace. Deliberately
  // not RFC 5322: a regex that accepts every legal address accepts nonsense too
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]{2,}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function domainOf(emailLower: string): string | null {
  const at = emailLower.lastIndexOf('@');
  if (at < 0) return null;
  const domain = emailLower.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/**
 * E.164 or nothing. A number stored in some local shorthand is a number that
 * will silently fail at the SMS gateway months later, when the cycle is live.
 */
export function normalisePhone(raw: string, defaultDialCode: string | null): string | null {
  const stripped = raw.replace(/[\s().-]/g, '');
  if (stripped.length === 0) return null;

  let candidate = stripped;
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  if (!candidate.startsWith('+')) {
    if (defaultDialCode === null) return null;
    candidate = `${defaultDialCode}${candidate.replace(/^0+/, '')}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

export function foldKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** For a substring search that a caller must not be able to turn into a pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
