import type { ClientSession } from 'mongoose';
import { TenantRepo } from '../../kernel/tenancy.js';
import { notFound } from '../../kernel/errors.js';
import { domainOf } from './sampling.sanitise.js';
import {
  BatchIntegrityModel,
  type BatchIntegrityDoc,
  type CustomerContactDoc,
  type IntegrityOccurrenceDoc,
  type SamplingSettingsDoc,
} from './sampling.models.js';
import type { IntegrityView } from './sampling.contracts.js';

/**
 * Integrity signals, recorded as counts and nothing else.
 *
 * An operator chooses who grades it, so the shape of that choice is worth
 * watching. What it is worth is not yet knowable: no cycle has run, so any
 * weighting written today would be a guess that gets quoted back as a
 * measurement. Every signal is therefore stored as an occurrence with its own
 * denominator, including the zeroes, so the weights can be fitted against real
 * cycles later rather than invented now.
 */

const integrity = new TenantRepo<BatchIntegrityDoc>(BatchIntegrityModel);

/** Enough ids to investigate a signal, few enough that the document stays small. */
const MAX_IDS_PER_OCCURRENCE = 100;

function occurrence(
  signal: IntegrityOccurrenceDoc['signal'],
  matched: readonly CustomerContactDoc[],
  denominator: number,
  detail: Record<string, string | number> = {},
): IntegrityOccurrenceDoc {
  return {
    signal,
    count: matched.length,
    denominator,
    contactIds: matched.slice(0, MAX_IDS_PER_OCCURRENCE).map((contact) => contact._id),
    detail: { ...detail, idsRecorded: Math.min(matched.length, MAX_IDS_PER_OCCURRENCE) },
  };
}

export function observe(
  contacts: readonly CustomerContactDoc[],
  settings: SamplingSettingsDoc,
  lockedAt: Date,
): IntegrityOccurrenceDoc[] {
  const operatorDomains = new Set(settings.operatorDomains);
  const freeMailDomains = new Set(settings.freeMailDomains);

  const withEmail = contacts.filter((contact) => domainOf(contact.emailLower) !== null);
  const withPhone = contacts.filter((contact) => contact.phoneE164 !== null);

  const onOperatorDomain = withEmail.filter((contact) => {
    const domain = domainOf(contact.emailLower);
    return domain !== null && operatorDomains.has(domain);
  });

  const onFreeMail = withEmail.filter((contact) => {
    const domain = domainOf(contact.emailLower);
    return domain !== null && freeMailDomains.has(domain);
  });

  const byPhone = new Map<string, CustomerContactDoc[]>();
  for (const contact of withPhone) {
    if (contact.phoneE164 === null) continue;
    const group = byPhone.get(contact.phoneE164) ?? [];
    group.push(contact);
    byPhone.set(contact.phoneE164, group);
  }
  const sharingPhone = [...byPhone.values()].filter((group) => group.length > 1);
  const duplicatePhone = sharingPhone.flat();

  // no upper bound: a contact in the selection necessarily existed before the
  // lock, so bounding at lockedAt only adds a clock skew failure mode
  const burstFrom = new Date(lockedAt.getTime() - settings.burstWindowMinutes * 60_000);
  const inBurst = contacts.filter((contact) => contact.createdAt >= burstFrom);

  const missingPhone = contacts.filter((contact) => contact.phoneE164 === null);

  return [
    occurrence('OPERATOR_DOMAIN_MATCH', onOperatorDomain, withEmail.length, {
      domainsConfigured: operatorDomains.size,
    }),
    occurrence('DUPLICATE_PHONE', duplicatePhone, withPhone.length, {
      numbersShared: sharingPhone.length,
    }),
    occurrence('FREE_MAIL_DOMAIN', onFreeMail, withEmail.length, {
      domainsConfigured: freeMailDomains.size,
    }),
    occurrence('ADDED_IN_BURST_BEFORE_LOCK', inBurst, contacts.length, {
      windowMinutes: settings.burstWindowMinutes,
      windowFrom: burstFrom.toISOString(),
    }),
    occurrence('MISSING_PHONE', missingPhone, contacts.length),
  ];
}

export async function recordIntegrity(
  args: {
    batchId: string;
    cycleId: string;
    contacts: readonly CustomerContactDoc[];
    settings: SamplingSettingsDoc;
    observedAt: Date;
  },
  session: ClientSession,
): Promise<void> {
  await integrity
    .findOneAndUpdate(
      { batchId: args.batchId },
      {
        $set: {
          cycleId: args.cycleId,
          observedAt: args.observedAt,
          contactsConsidered: args.contacts.length,
          occurrences: observe(args.contacts, args.settings, args.observedAt),
        },
      },
      { upsert: true, session },
    )
    .exec();
}

export async function readIntegrity(batchId: string): Promise<IntegrityView> {
  const doc = await integrity.findOne({ batchId }).lean().exec();
  if (!doc) throw notFound('No integrity observations for this batch');

  return {
    batchId: doc.batchId,
    cycleId: doc.cycleId,
    observedAt: doc.observedAt.toISOString(),
    contactsConsidered: doc.contactsConsidered,
    occurrences: doc.occurrences.map((row) => ({
      signal: row.signal,
      count: row.count,
      denominator: row.denominator,
      contactIds: [...row.contactIds],
      detail: { ...row.detail },
    })),
  };
}
