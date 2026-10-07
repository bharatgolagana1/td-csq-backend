/**
 * Tolerant header matching for the customer CSV: case- and
 * punctuation-insensitive, with the synonyms operators actually use.
 */
import { CUSTOMER_CSV_COLUMNS, type CustomerCsvField } from './csvTemplate.js';

const SYNONYMS: Record<CustomerCsvField, readonly string[]> = {
  name: ['name', 'organisationname', 'organizationname', 'organisation', 'organization', 'orgname', 'company', 'companyname', 'customer', 'customername', 'firm', 'firmname'],
  contactPerson: ['contactperson', 'contact', 'contactname', 'personname', 'person', 'contactpersonname', 'pointofcontact', 'poc'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'mailid', 'contactemail'],
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno', 'contactnumber', 'contactno', 'telephone', 'tel', 'cell', 'cellphone', 'phonemobile', 'mobilephone', 'whatsapp', 'whatsappnumber'],
  type: ['type', 'stakeholdertype', 'customertype', 'membertype', 'category', 'stakeholder', 'role'],
  surveyType: ['surveytype', 'survey', 'operations', 'operation', 'cargotype', 'scope', 'surveyscope', 'assessmenttype', 'domesticinternational'],
  tags: ['tags', 'tag', 'labels', 'label', 'group', 'groups'],
};

/** Lower-case, drop bracketed hints ("Type (FF/CB)"), keep letters and digits only. */
export function normaliseHeader(header: string): string {
  return header
    .replace(/\uFEFF/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const lookup = new Map<string, CustomerCsvField>();
for (const column of CUSTOMER_CSV_COLUMNS) {
  lookup.set(normaliseHeader(column.header), column.key);
  for (const synonym of SYNONYMS[column.key]) lookup.set(synonym, column.key);
}

/** The template field a header names, or null. */
export function matchHeader(header: string): CustomerCsvField | null {
  return lookup.get(normaliseHeader(header)) ?? null;
}

export interface HeaderMap {
  /** Column index per matched field. */
  columns: Partial<Record<CustomerCsvField, number>>;
  /** Header text per matched field, as written in the file. */
  matched: Partial<Record<CustomerCsvField, string>>;
  /** Headers that matched nothing, or a field already taken by an earlier column. */
  ignored: string[];
  /** Required template fields with no column. */
  missing: CustomerCsvField[];
}

/** Maps a header row to template fields; the first column that names a field wins. */
export function mapHeaders(headers: readonly string[]): HeaderMap {
  const columns: Partial<Record<CustomerCsvField, number>> = {};
  const matched: Partial<Record<CustomerCsvField, string>> = {};
  const ignored: string[] = [];
  headers.forEach((header, index) => {
    const field = matchHeader(header);
    if (field === null || columns[field] !== undefined) {
      if (header.trim() !== '') ignored.push(header);
      return;
    }
    columns[field] = index;
    matched[field] = header;
  });
  const missing = CUSTOMER_CSV_COLUMNS.filter((column) => column.required && columns[column.key] === undefined).map(
    (column) => column.key,
  );
  return { columns, matched, ignored, missing };
}
