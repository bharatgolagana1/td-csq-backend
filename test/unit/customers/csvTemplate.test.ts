import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_CSV_COLUMNS,
  CUSTOMER_CSV_HEADERS,
  customerCsvTemplate,
  sampleCustomerRows,
} from '../../../src/modules/customers/domain/csvTemplate.js';
import { validateCustomerCsv } from '../../../src/modules/customers/domain/csvValidate.js';

describe('customer CSV template', () => {
  it('has the seven documented columns in order', () => {
    expect(CUSTOMER_CSV_HEADERS).toEqual(['Name', 'Contact person', 'Email', 'Phone', 'Type', 'Survey type', 'Tags']);
    expect(CUSTOMER_CSV_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual([
      'name',
      'contactPerson',
      'email',
      'phone',
      'type',
      'surveyType',
    ]);
  });

  it('starts with the header line, uses CRLF and ends with a newline', () => {
    const text = customerCsvTemplate();
    expect(text.startsWith('Name,Contact person,Email,Phone,Type,Survey type,Tags\r\n')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n').filter((line) => line !== '')).toHaveLength(4);
  });

  it('can be a bare header', () => {
    expect(customerCsvTemplate({ sampleRows: 0 })).toBe('Name,Contact person,Email,Phone,Type,Survey type,Tags\r\n');
  });

  it('sample rows are deterministic, alternate FF/CB and cycle the survey types', () => {
    const rows = sampleCustomerRows(4);
    expect(rows.map((r) => r.type)).toEqual(['FF', 'CB', 'FF', 'CB']);
    expect(rows.map((r) => r.surveyType)).toEqual(['DOMESTIC', 'INTERNATIONAL', 'BOTH', 'DOMESTIC']);
    expect(rows.map((r) => r.email)).toEqual(['customer1@example.com', 'customer2@example.com', 'customer3@example.com', 'customer4@example.com']);
    expect(sampleCustomerRows(4)).toEqual(rows);
    expect(() => sampleCustomerRows(-1)).toThrow(RangeError);
  });

  it('round-trips: the template validates with no errors', () => {
    const result = validateCustomerCsv(customerCsvTemplate({ sampleRows: 5 }), { existingEmails: [] });
    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(5);
    expect(result.accepted).toBe(5);
    expect(result.records.map((r) => r.data.tags)).toEqual([['sample', 'priority'], ['sample'], ['sample', 'priority'], ['sample'], ['sample', 'priority']]);
  });
});
