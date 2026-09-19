/**
 * A strict RFC 4180 reader for the vendored reference files.
 *
 * It is here rather than in a dependency because the only CSV this system ever
 * reads is a file it vendored itself, and because a lenient reader is the wrong
 * tool: a quote in the wrong place in a public dataset should stop the seed,
 * not be guessed at. Lines beginning with # are treated as provenance comments,
 * which is how the source, licence and filter stay attached to the data.
 */

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'CsvError';
  }
}

function splitLine(line: string, lineNumber: number): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < line.length) {
    const char = line[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
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
    if (char === '"') {
      if (field.length > 0) throw new CsvError('a quote may only open a field', lineNumber);
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      fields.push(field);
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) throw new CsvError('unterminated quoted field', lineNumber);
  fields.push(field);
  return fields;
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/);
  let header: string[] | undefined;
  const rows: Array<Record<string, string>> = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0 || line.startsWith('#')) return;

    const fields = splitLine(line, lineNumber);
    if (!header) {
      header = fields;
      return;
    }
    if (fields.length !== header.length) {
      throw new CsvError(`expected ${header.length} fields, found ${fields.length}`, lineNumber);
    }
    const row: Record<string, string> = {};
    header.forEach((name, position) => {
      row[name] = fields[position] ?? '';
    });
    rows.push(row);
  });

  if (!header) throw new CsvError('the file has no header row', 0);
  return rows;
}
