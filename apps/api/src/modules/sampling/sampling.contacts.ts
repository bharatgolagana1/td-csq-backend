import type { ClientSession } from 'mongoose';
import type { FormScope } from '@csq/contracts';
import { TenantRepo } from '../../kernel/tenancy.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { appendAudit } from './sampling.audit.js';
import { isDuplicateKey } from './sampling.db.js';
import { loadSamplingSettings } from './sampling.policy.js';
import { CustomerContactModel, type CustomerContactDoc } from './sampling.models.js';
import {
  escapeRegex,
  foldKey,
  normaliseEmail,
  normalisePhone,
  toCsv,
} from './sampling.sanitise.js';
import type {
  ContactQuery,
  ContactView,
  CreateContact,
  ExportQuery,
  UpdateContact,
} from './sampling.contracts.js';

/**
 * The customer directory. One address is one customer inside an organisation,
 * enforced by a unique index rather than by a lookup before the insert, because
 * two operators pasting the same spreadsheet at the same time will both find
 * nothing and both write.
 */

const contacts = new TenantRepo<CustomerContactDoc>(CustomerContactModel);

/** The columns the export writes and the CSV import reads. */
export const EXPORT_HEADER = ['name', 'company', 'email', 'phone', 'customerType', 'formScope', 'status'] as const;

export function toContactView(doc: CustomerContactDoc): ContactView {
  return {
    id: doc._id,
    name: doc.name,
    company: doc.company,
    email: doc.email,
    phoneE164: doc.phoneE164,
    customerType: doc.customerType,
    formScope: doc.formScope,
    status: doc.status,
    source: doc.source,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function requirePhone(raw: string | null): Promise<string | null> {
  if (raw === null || raw.trim().length === 0) return null;
  const settings = await loadSamplingSettings();
  const phone = normalisePhone(raw, settings.defaultDialCode);
  if (phone === null) {
    throw fail('VALIDATION_FAILED', 'Request failed validation', [
      {
        path: 'phone',
        message:
          'must be reachable in E.164, e.g. +919812345678. Set a default dialling code in sampling settings to accept national numbers',
      },
    ]);
  }
  return phone;
}

function requireEmail(raw: string): string {
  const email = normaliseEmail(raw);
  if (email === null) {
    throw fail('VALIDATION_FAILED', 'Request failed validation', [
      { path: 'email', message: 'must be an email address' },
    ]);
  }
  return email;
}

export async function createContact(input: CreateContact): Promise<ContactView> {
  const emailLower = requireEmail(input.email);
  const phoneE164 = await requirePhone(input.phone);

  try {
    const created = await contacts.create({
      name: input.name.trim(),
      company: input.company.trim(),
      email: input.email.trim(),
      emailLower,
      companyKey: foldKey(input.company),
      phoneE164,
      customerType: input.customerType,
      formScope: input.formScope,
      status: 'ACTIVE',
      source: 'MANUAL',
      lastImportId: null,
    });

    await appendAudit([
      {
        action: 'CONTACT_CREATED',
        subjectType: 'CONTACT',
        subjectId: created._id,
        detail: { email: emailLower, company: created.company, source: 'MANUAL' },
      },
    ]);
    return toContactView(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${emailLower} is already in this directory`);
    throw error;
  }
}

export async function readContact(contactId: string): Promise<ContactView> {
  const doc = await contacts.findById(contactId).lean().exec();
  if (!doc) throw notFound('No such contact');
  return toContactView(doc);
}

export async function updateContact(contactId: string, patch: UpdateContact): Promise<ContactView> {
  const assignments: Record<string, unknown> = {};

  if (patch.name !== undefined) assignments['name'] = patch.name.trim();
  if (patch.company !== undefined) {
    assignments['company'] = patch.company.trim();
    assignments['companyKey'] = foldKey(patch.company);
  }
  if (patch.email !== undefined) {
    assignments['emailLower'] = requireEmail(patch.email);
    assignments['email'] = patch.email.trim();
  }
  if (patch.phone !== undefined) assignments['phoneE164'] = await requirePhone(patch.phone);
  if (patch.customerType !== undefined) assignments['customerType'] = patch.customerType;
  if (patch.formScope !== undefined) assignments['formScope'] = patch.formScope;
  if (patch.status !== undefined) assignments['status'] = patch.status;

  try {
    const updated = await contacts.findOneAndUpdate({ _id: contactId }, { $set: assignments }).lean().exec();
    if (!updated) throw notFound('No such contact');

    await appendAudit([
      {
        action: patch.status !== undefined && Object.keys(patch).length === 1 ? 'CONTACT_STATUS_CHANGED' : 'CONTACT_UPDATED',
        subjectType: 'CONTACT',
        subjectId: contactId,
        detail: { fields: Object.keys(patch).sort().join(','), email: updated.emailLower },
      },
    ]);
    return toContactView(updated);
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('Another contact in this directory already uses that address');
    throw error;
  }
}

/**
 * Contacts are deactivated, never deleted. A locked batch names them, and a
 * sample whose members can be removed from under it is not a locked sample.
 */
export async function deactivateContact(contactId: string): Promise<ContactView> {
  const updated = await contacts
    .findOneAndUpdate({ _id: contactId, status: { $ne: 'INACTIVE' } }, { $set: { status: 'INACTIVE' } })
    .lean()
    .exec();
  if (!updated) {
    const existing = await contacts.findById(contactId).lean().exec();
    if (!existing) throw notFound('No such contact');
    return toContactView(existing);
  }

  await appendAudit([
    {
      action: 'CONTACT_STATUS_CHANGED',
      subjectType: 'CONTACT',
      subjectId: contactId,
      detail: { status: 'INACTIVE', email: updated.emailLower },
    },
  ]);
  return toContactView(updated);
}

function contactFilter(query: Pick<ContactQuery, 'status' | 'customerType' | 'formScope' | 'search'>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.status !== undefined) filter['status'] = query.status;
  if (query.customerType !== undefined) filter['customerType'] = query.customerType;
  if (query.formScope !== undefined) filter['formScope'] = query.formScope;
  if (query.search !== undefined) {
    // escaped, so a caller cannot turn a search box into a pattern that scans
    // the collection for as long as the request timeout allows
    const pattern = new RegExp(escapeRegex(foldKey(query.search)));
    filter['$or'] = [{ companyKey: pattern }, { emailLower: pattern }];
  }
  return filter;
}

export async function listContacts(query: ContactQuery): Promise<{ contacts: ContactView[]; nextCursor: string | null }> {
  const filter = contactFilter(query);
  if (query.cursor !== undefined) filter['_id'] = { $gt: query.cursor };

  const rows = await contacts
    .find(filter)
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean()
    .exec();

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    contacts: page.map(toContactView),
    nextCursor: rows.length > query.limit && last !== undefined ? last._id : null,
  };
}

/** A bound, because an unbounded export is a denial of service control nobody wrote. */
const MAX_EXPORT_ROWS = 50_000;

/** The export is the import template, so it writes exactly the columns the import reads. */
export async function exportContactsCsv(query: ExportQuery): Promise<string> {
  const rows = await contacts
    .find(contactFilter(query))
    .sort({ _id: 1 })
    .limit(MAX_EXPORT_ROWS)
    .lean()
    .exec();
  return toCsv(
    EXPORT_HEADER,
    rows.map((row) => [
      row.name,
      row.company,
      row.email,
      row.phoneE164 ?? '',
      row.customerType,
      row.formScope,
      row.status,
    ]),
  );
}

/** Eligible for sampling: reachable, not opted out, and on the right form. */
export function eligibleFilter(formScope: FormScope): Record<string, unknown> {
  return { status: 'ACTIVE', formScope };
}

export async function countEligible(formScope: FormScope): Promise<number> {
  return contacts.countDocuments(eligibleFilter(formScope));
}

export async function loadContacts(ids: readonly string[], session?: ClientSession): Promise<CustomerContactDoc[]> {
  if (ids.length === 0) return [];
  const query = contacts.find({ _id: { $in: [...ids] } });
  if (session) query.session(session);
  return query.lean().exec();
}

export async function loadEligible(
  formScope: FormScope,
  ids: readonly string[],
  session?: ClientSession,
): Promise<CustomerContactDoc[]> {
  if (ids.length === 0) return [];
  const query = contacts.find({ ...eligibleFilter(formScope), _id: { $in: [...ids] } });
  if (session) query.session(session);
  return query.lean().exec();
}
