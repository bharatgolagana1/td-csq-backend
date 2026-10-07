import { describe, expect, it } from 'vitest';

import { validateCustomerCsv } from '../../../src/modules/customers/domain/csvValidate.js';

const BOM = '\uFEFF';

describe('validateCustomerCsv', () => {
  it('accepts a messy real-world file: BOM, CRLF, odd headers, quoted commas, extra column', () => {
    const text =
      `${BOM}Organisation Name,Contact Person,E-Mail Address,Mobile No.,Type (FF/CB),Survey Type,Tags,GSTIN\r\n` +
      `"Falcon Freight, Pvt Ltd",Asha Rao,ASHA@Falcon.IN,98765 43210,Freight Forwarder,Domestic & International,vip; north,27AAAAA0000A1Z5\r\n` +
      `Swift Clearing,,swift@clear.in,+91-98765-00001,CHA,intl,,\r\n`;
    const result = validateCustomerCsv(text, { existingEmails: ['SWIFT@clear.in'] });

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ rows: 2, accepted: 2, rejected: 0 });
    expect(result.headers.ignored).toEqual(['GSTIN']);
    expect(result.headers.matched.email).toBe('E-Mail Address');
    expect(result.records).toEqual([
      {
        row: 2,
        action: 'CREATE',
        data: {
          name: 'Falcon Freight, Pvt Ltd',
          contactPerson: 'Asha Rao',
          email: 'asha@falcon.in',
          phone: '+919876543210',
          type: 'FF',
          surveyType: 'BOTH',
          tags: ['vip', 'north'],
        },
      },
      {
        row: 3,
        action: 'UPDATE',
        data: {
          name: 'Swift Clearing',
          contactPerson: 'Swift Clearing',
          email: 'swift@clear.in',
          phone: '+919876500001',
          type: 'CB',
          surveyType: 'INTERNATIONAL',
          tags: [],
        },
      },
    ]);
    expect(result.preview.map((p) => [p.row, p.action])).toEqual([
      [2, 'CREATE'],
      [3, 'UPDATE'],
    ]);
  });

  it('marks in-file duplicates (case- and space-insensitive) as rejected, pointing at the first row', () => {
    const text =
      'Name,Contact person,Email,Phone,Type,Survey type\n' +
      'A,A,dup@x.in,9876543210,FF,DOMESTIC\n' +
      'B,B, DUP@X.IN ,9876543211,CB,DOMESTIC\n';
    const result = validateCustomerCsv(text, { existingEmails: [] });
    expect(result).toMatchObject({ rows: 2, accepted: 1, rejected: 1 });
    expect(result.errors).toEqual([{ row: 3, field: 'email', message: 'Duplicate of row 2 (dup@x.in)' }]);
    expect(result.preview[1]).toMatchObject({ row: 3, action: 'REJECT' });
  });

  it('reports every bad field on a row and keeps spreadsheet row numbers across blank lines', () => {
    const text =
      'Name,Contact person,Email,Phone,Type,Survey type\n' +
      'Good Co,G,good@x.in,9876543210,FF,DOMESTIC\n' +
      '\n' +
      ',X,not-an-email,12345,Airline,Regional\n';
    const result = validateCustomerCsv(text, { existingEmails: [] });
    expect(result).toMatchObject({ rows: 2, accepted: 1, rejected: 1 });
    expect(result.errors.map((e) => [e.row, e.field])).toEqual([
      [4, 'name'],
      [4, 'email'],
      [4, 'phone'],
      [4, 'type'],
      [4, 'surveyType'],
    ]);
    expect(result.preview[1]).toMatchObject({ row: 4, action: 'REJECT', data: { phone: '12345', type: 'Airline' } });
  });

  it('rejects an invalid phone and a missing survey type individually', () => {
    const text =
      'Name,Contact person,Email,Phone,Type,Survey type\n' +
      'A,A,a@x.in,5551234,FF,DOMESTIC\n' +
      'B,B,b@x.in,9876543210,CB,\n';
    const result = validateCustomerCsv(text, { existingEmails: [] });
    expect(result.errors.map((e) => [e.row, e.field])).toEqual([
      [2, 'phone'],
      [3, 'surveyType'],
    ]);
    expect(result.errors[0]?.message).toContain('10-digit Indian mobile');
    expect(result.errors[1]?.message).toContain('Survey type is required');
    expect(result.accepted).toBe(0);
  });

  it('fails the whole file when a required column is missing', () => {
    const result = validateCustomerCsv('Name,Email,Phone\nA,a@x.in,9876543210\n', { existingEmails: [] });
    expect(result).toMatchObject({ rows: 0, accepted: 0, rejected: 0 });
    expect(result.errors).toEqual([{ row: 1, field: 'header', message: 'Missing column(s): contactPerson, type, surveyType' }]);
    expect(result.headers.missing).toEqual(['contactPerson', 'type', 'surveyType']);
  });

  it('handles empty and header-only files', () => {
    expect(validateCustomerCsv('', { existingEmails: [] }).errors).toEqual([{ row: 0, field: 'file', message: 'The file is empty' }]);
    expect(validateCustomerCsv(`${BOM}\n\n`, { existingEmails: [] }).errors[0]?.field).toBe('file');
    const headerOnly = validateCustomerCsv('Name,Contact person,Email,Phone,Type,Survey type\n', { existingEmails: [] });
    expect(headerOnly.errors).toEqual([{ row: 0, field: 'file', message: 'No data rows under the header' }]);
    expect(headerOnly.rows).toBe(0);
  });

  it('refuses files over the row limit without validating them', () => {
    const header = 'Name,Contact person,Email,Phone,Type,Survey type\n';
    const rows = Array.from({ length: 4 }, (_, i) => `C${i},P,c${i}@x.in,987654321${i},FF,DOMESTIC`).join('\n');
    const result = validateCustomerCsv(`${header}${rows}\n`, { existingEmails: [], maxRows: 3 });
    expect(result).toMatchObject({ rows: 4, accepted: 0, rejected: 4, records: [], preview: [] });
    expect(result.errors).toEqual([{ row: 0, field: 'file', message: 'Too many rows: 4 (maximum 3)' }]);
  });

  it('defaults the limit to 5,000 rows and accepts exactly 5,000', () => {
    const header = 'Name,Contact person,Email,Phone,Type,Survey type\n';
    const rows = Array.from({ length: 5000 }, (_, i) => `C${i},P,c${i}@x.in,+91${9000000000 + i},FF,DOMESTIC`).join('\n');
    const result = validateCustomerCsv(`${header}${rows}\n`, { existingEmails: [] });
    expect(result).toMatchObject({ rows: 5000, accepted: 5000, rejected: 0 });
    expect(result.preview).toHaveLength(20);
    const tooMany = validateCustomerCsv(`${header}${rows}\nExtra,P,extra@x.in,9876543210,FF,DOMESTIC\n`, { existingEmails: [] });
    expect(tooMany.errors[0]?.message).toBe('Too many rows: 5,001 (maximum 5,000)');
  });

  it('honours previewLimit and still returns every record', () => {
    const header = 'Name,Contact person,Email,Phone,Type,Survey type\n';
    const rows = Array.from({ length: 5 }, (_, i) => `C${i},P,c${i}@x.in,987654321${i},FF,DOMESTIC`).join('\n');
    const result = validateCustomerCsv(`${header}${rows}\n`, { existingEmails: [], previewLimit: 2 });
    expect(result.preview).toHaveLength(2);
    expect(result.records).toHaveLength(5);
  });

  it('reads tab-separated exports too', () => {
    const text = 'Name\tContact person\tEmail\tPhone\tType\tSurvey type\nTabbed Co\tT\ttab@x.in\t9876543210\tFF\tBOTH\n';
    const result = validateCustomerCsv(text, { existingEmails: [] });
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.data).toMatchObject({ name: 'Tabbed Co', surveyType: 'BOTH' });
  });

  it('treats a row that is an UPDATE and later a duplicate correctly', () => {
    const text =
      'Name,Contact person,Email,Phone,Type,Survey type\n' +
      'Old,O,old@x.in,9876543210,FF,DOMESTIC\n' +
      'Old again,O,old@x.in,9876543210,FF,DOMESTIC\n';
    const result = validateCustomerCsv(text, { existingEmails: ['old@x.in'] });
    expect(result.records.map((r) => r.action)).toEqual(['UPDATE']);
    expect(result.errors[0]?.message).toBe('Duplicate of row 2 (old@x.in)');
  });
});
