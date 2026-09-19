import { z } from 'zod';
import { FormScope, Ulid } from '@csq/contracts';

/**
 * The wire shapes of the sampling module: the customer directory, the two phase
 * import, batches and their review.
 *
 * Nothing here is reference data. Every enum is a closed contract the frontend
 * switches on; every value an operator can type arrives through an endpoint and
 * is stored in MongoDB.
 */

export const CUSTOMER_TYPES = ['FREIGHT_FORWARDER', 'CUSTOMS_BROKER', 'SELF_CLEARANCE'] as const;
export const CustomerType = z.enum(CUSTOMER_TYPES);
export type CustomerType = z.infer<typeof CustomerType>;

/**
 * BOUNCED and SUPPRESSED are separate because they mean different things to the
 * gate and to the operator. A bounce is the mail server's verdict on an address;
 * a suppression is a person asking not to be contacted, and unlike a bounce it
 * must never be cleared by re-importing the same spreadsheet.
 */
export const CONTACT_STATUSES = ['ACTIVE', 'INACTIVE', 'BOUNCED', 'SUPPRESSED'] as const;
export const ContactStatus = z.enum(CONTACT_STATUSES);
export type ContactStatus = z.infer<typeof ContactStatus>;

export const CONTACT_SOURCES = ['MANUAL', 'IMPORT', 'REVIEW'] as const;
export const ContactSource = z.enum(CONTACT_SOURCES);
export type ContactSource = z.infer<typeof ContactSource>;

/** E.164 and nothing else, because that is the only form an SMS gateway accepts. */
export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 number, e.g. +919812345678');

export const MAX_IMPORT_ROWS = 5000;
export const MAX_BATCH_SELECTION = 5000;

const LooseEmail = z.string().min(3).max(320);
const LoosePhone = z.string().min(6).max(40);

export const CreateContact = z
  .object({
    name: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    email: LooseEmail,
    phone: LoosePhone.nullable().default(null),
    customerType: CustomerType,
    formScope: FormScope,
  })
  .strict();
export type CreateContact = z.infer<typeof CreateContact>;

export const UpdateContact = z
  .object({
    name: z.string().min(1).max(200).optional(),
    company: z.string().min(1).max(200).optional(),
    email: LooseEmail.optional(),
    phone: LoosePhone.nullable().optional(),
    customerType: CustomerType.optional(),
    formScope: FormScope.optional(),
    status: ContactStatus.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateContact = z.infer<typeof UpdateContact>;

export const ContactIdParam = z.object({ contactId: Ulid });

export const ContactQuery = z
  .object({
    status: ContactStatus.optional(),
    customerType: CustomerType.optional(),
    formScope: FormScope.optional(),
    /** Case folded substring of company or email. */
    search: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Exclusive start, a contact id. Ids are ULIDs, so the order is creation order. */
    cursor: Ulid.optional(),
  })
  .strict();
export type ContactQuery = z.infer<typeof ContactQuery>;

export const ContactView = z.object({
  id: Ulid,
  name: z.string(),
  company: z.string(),
  email: z.string(),
  phoneE164: z.string().nullable(),
  customerType: CustomerType,
  formScope: FormScope,
  status: ContactStatus,
  source: ContactSource,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContactView = z.infer<typeof ContactView>;

/**
 * Import is two phase on purpose. An operator pasting 400 rows needs to see what
 * will happen before anything is written, and the commit needs to be replayable
 * after a dropped connection without creating the directory twice.
 */
export const IMPORT_MODES = ['UPSERT', 'CREATE_ONLY'] as const;
export const ImportMode = z.enum(IMPORT_MODES);
export type ImportMode = z.infer<typeof ImportMode>;

export const IMPORT_COLUMNS = ['name', 'company', 'email', 'phone', 'customerType', 'formScope'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const ImportRow = z
  .object({
    name: z.string().max(400).optional(),
    company: z.string().max(400).optional(),
    email: z.string().max(400).optional(),
    phone: z.string().max(80).optional(),
    customerType: z.string().max(80).optional(),
    formScope: z.string().max(80).optional(),
  })
  .strict();
export type ImportRow = z.infer<typeof ImportRow>;

/**
 * Either parsed rows or the raw CSV text. The export endpoint emits exactly the
 * header the CSV branch accepts, so export, edit in a spreadsheet and import is
 * a closed loop rather than three different column vocabularies.
 */
export const ValidateImport = z
  .object({
    mode: ImportMode.default('UPSERT'),
    fileName: z.string().min(1).max(200).nullable().default(null),
    rows: z.array(ImportRow).max(MAX_IMPORT_ROWS).optional(),
    csv: z.string().max(4_000_000).optional(),
  })
  .strict()
  .refine((v) => (v.rows === undefined) !== (v.csv === undefined), 'send exactly one of rows or csv');
export type ValidateImport = z.infer<typeof ValidateImport>;

export const IMPORT_ROW_PROBLEMS = [
  'MISSING_REQUIRED',
  'INVALID_EMAIL',
  'INVALID_PHONE',
  'UNKNOWN_CUSTOMER_TYPE',
  'UNKNOWN_FORM_SCOPE',
  'DUPLICATE_IN_FILE',
  'ALREADY_ON_FILE',
  'TOO_LONG',
] as const;
export const ImportRowProblem = z.enum(IMPORT_ROW_PROBLEMS);
export type ImportRowProblem = z.infer<typeof ImportRowProblem>;

export const IMPORT_ROW_OUTCOMES = ['CREATE', 'UPDATE', 'SKIP', 'REJECT'] as const;
export const ImportRowOutcome = z.enum(IMPORT_ROW_OUTCOMES);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcome>;

export const ImportRowReport = z.object({
  /** 1 based, matching what the operator sees in the spreadsheet. */
  line: z.number().int().min(1),
  outcome: ImportRowOutcome,
  email: z.string().nullable(),
  company: z.string().nullable(),
  problems: z.array(z.object({ column: z.string(), code: ImportRowProblem, message: z.string() })),
  /** True when a formula prefix or a control character was stripped from a cell. */
  sanitised: z.boolean(),
});
export type ImportRowReport = z.infer<typeof ImportRowReport>;

export const ImportView = z.object({
  id: Ulid,
  state: z.enum(['VALIDATED', 'COMMITTED']),
  mode: ImportMode,
  fileName: z.string().nullable(),
  counts: z.object({
    total: z.number().int().min(0),
    create: z.number().int().min(0),
    update: z.number().int().min(0),
    skip: z.number().int().min(0),
    reject: z.number().int().min(0),
    sanitised: z.number().int().min(0),
  }),
  rows: z.array(ImportRowReport),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
});
export type ImportView = z.infer<typeof ImportView>;

export const ImportIdParam = z.object({ importId: Ulid });

export const CreateBatch = z
  .object({
    cycleId: Ulid,
    formScope: FormScope,
    label: z.string().min(1).max(120).nullable().default(null),
  })
  .strict();
export type CreateBatch = z.infer<typeof CreateBatch>;

export const SetSelection = z
  .object({ contactIds: z.array(Ulid).max(MAX_BATCH_SELECTION) })
  .strict();

export const BatchIdParam = z.object({ batchId: Ulid });

export const BatchQuery = z
  .object({
    cycleId: Ulid.optional(),
    state: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: Ulid.optional(),
  })
  .strict();
export type BatchQuery = z.infer<typeof BatchQuery>;

export const BATCH_STATES = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;
export const BatchState = z.enum(BATCH_STATES);
export type BatchState = z.infer<typeof BatchState>;

export const APPROVAL_MODES = ['AUTO', 'SUPER_ADMIN'] as const;
export const ApprovalMode = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/**
 * Every reviewer edit carries one of these. A free text note is allowed beside
 * it but never instead of it: a reason the system cannot group is a reason
 * nobody will ever count.
 */
export const REVIEW_REASON_CODES = [
  'ADDED_MISSING_CUSTOMER',
  'ADDED_FOR_COVERAGE',
  'REMOVED_NOT_A_CUSTOMER',
  'REMOVED_RELATED_PARTY',
  'REMOVED_DUPLICATE',
  'REMOVED_UNREACHABLE',
  'CORRECTED_CONTACT_DETAILS',
  'CORRECTED_CUSTOMER_TYPE',
] as const;
export const ReviewReasonCode = z.enum(REVIEW_REASON_CODES);
export type ReviewReasonCode = z.infer<typeof ReviewReasonCode>;

export const REJECTION_REASON_CODES = [
  'SAMPLE_NOT_REPRESENTATIVE',
  'RELATED_PARTIES_INCLUDED',
  'CONTACT_DETAILS_UNVERIFIABLE',
  'DUPLICATES_PRESENT',
  'BELOW_MINIMUM_AFTER_REVIEW',
  'OTHER',
] as const;
export const RejectionReasonCode = z.enum(REJECTION_REASON_CODES);
export type RejectionReasonCode = z.infer<typeof RejectionReasonCode>;

const Note = z.string().min(1).max(1000);

export const ReviewAdd = z
  .object({
    contactIds: z.array(Ulid).min(1).max(200),
    reasonCode: ReviewReasonCode,
    note: Note.nullable().default(null),
  })
  .strict();

export const ReviewRemove = z
  .object({
    contactIds: z.array(Ulid).min(1).max(200),
    reasonCode: ReviewReasonCode,
    note: Note.nullable().default(null),
  })
  .strict();

export const ReviewCorrect = z
  .object({
    contactId: Ulid,
    changes: UpdateContact,
    reasonCode: ReviewReasonCode,
    note: Note.nullable().default(null),
  })
  .strict();

export const ApproveBatch = z.object({ note: Note.nullable().default(null) }).strict();

export const RejectBatch = z
  .object({
    reasonCode: RejectionReasonCode,
    findings: z
      .array(z.object({ contactId: Ulid.nullable().default(null), detail: z.string().min(1).max(500) }))
      .max(100)
      .default([]),
    note: Note.nullable().default(null),
  })
  .strict()
  // OTHER groups nothing by itself, so it has to say what it means
  .refine((v) => v.reasonCode !== 'OTHER' || (v.note !== null && v.note.length > 0), {
    path: ['note'],
    message: 'a note is required when the reason code is OTHER',
  });

export const GateView = z.object({
  minimumSamplingSize: z.number().int().min(1),
  eligibleCount: z.number().int().min(0),
  /** Everyone locked into this cycle already, plus this batch's own selection. */
  cumulativeSelectedCount: z.number().int().min(0),
  selectedCount: z.number().int().min(0),
  ok: z.boolean(),
  mustSelectAll: z.boolean(),
  shortfall: z.number().int().min(0),
  reason: z.enum(['BELOW_MINIMUM', 'NOT_ALL_SELECTED', 'EMPTY_DIRECTORY']).nullable(),
  needed: z.number().int().min(0),
  explanation: z.string(),
});
export type GateView = z.infer<typeof GateView>;

export const BatchView = z.object({
  id: Ulid,
  cycleId: Ulid,
  formScope: FormScope,
  label: z.string().nullable(),
  state: BatchState,
  contactCount: z.number().int().min(0),
  submittedCount: z.number().int().min(0),
  lockedAt: z.string().nullable(),
  lockedBy: Ulid.nullable(),
  approvalMode: ApprovalMode.nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: Ulid.nullable(),
  rejection: z
    .object({
      reasonCode: RejectionReasonCode,
      findings: z.array(z.object({ contactId: Ulid.nullable(), detail: z.string() })),
      note: z.string().nullable(),
    })
    .nullable(),
  lockGate: GateView.nullable(),
  createdAt: z.string(),
});
export type BatchView = z.infer<typeof BatchView>;

export const REVIEW_CHANGE_KINDS = ['ADD', 'REMOVE', 'CORRECT'] as const;
export const ReviewChangeKind = z.enum(REVIEW_CHANGE_KINDS);
export type ReviewChangeKind = z.infer<typeof ReviewChangeKind>;

export const DiffView = z.object({
  batchId: Ulid,
  state: BatchState,
  submittedCount: z.number().int().min(0),
  currentCount: z.number().int().min(0),
  added: z.array(ContactView),
  removed: z.array(ContactView),
  corrected: z.array(
    z.object({
      contactId: Ulid,
      fields: z.array(z.string()),
      reasonCode: ReviewReasonCode,
      at: z.string(),
      by: Ulid,
    }),
  ),
  changes: z.array(
    z.object({
      at: z.string(),
      by: Ulid,
      kind: ReviewChangeKind,
      contactId: Ulid,
      reasonCode: ReviewReasonCode,
      note: z.string().nullable(),
    }),
  ),
});
export type DiffView = z.infer<typeof DiffView>;

/**
 * Integrity observations are counted, never scored. The weights that turn these
 * into a judgement can only be fitted against a cycle that has actually run, and
 * a number invented before then would be defended as if it had been measured.
 */
export const INTEGRITY_SIGNALS = [
  'OPERATOR_DOMAIN_MATCH',
  'DUPLICATE_PHONE',
  'FREE_MAIL_DOMAIN',
  'ADDED_IN_BURST_BEFORE_LOCK',
  'MISSING_PHONE',
] as const;
export const IntegritySignal = z.enum(INTEGRITY_SIGNALS);
export type IntegritySignal = z.infer<typeof IntegritySignal>;

export const IntegrityView = z.object({
  batchId: Ulid,
  cycleId: Ulid,
  observedAt: z.string(),
  contactsConsidered: z.number().int().min(0),
  occurrences: z.array(
    z.object({
      signal: IntegritySignal,
      count: z.number().int().min(0),
      /** What count is out of, so a ratio can be fitted later without guessing. */
      denominator: z.number().int().min(0),
      contactIds: z.array(Ulid),
      detail: z.record(z.union([z.string(), z.number()])),
    }),
  ),
});
export type IntegrityView = z.infer<typeof IntegrityView>;

export const SamplingSettingsView = z.object({
  approvalMode: ApprovalMode,
  /** Domains the operator itself owns. A sampled address on one of these is recorded. */
  operatorDomains: z.array(z.string()),
  /** Consumer mail domains, typed in by an administrator. Nothing is seeded. */
  freeMailDomains: z.array(z.string()),
  /** How long before a lock counts as "just before" for the burst observation. */
  burstWindowMinutes: z.number().int().min(1).max(10_080),
  /** Prefixed to a national number on import when the number has no + form. */
  defaultDialCode: z.string().nullable(),
  updatedAt: z.string(),
});
export type SamplingSettingsView = z.infer<typeof SamplingSettingsView>;

const Domain = z
  .string()
  .min(3)
  .max(253)
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be a domain name'));

export const SamplingSettingsPatch = z
  .object({
    approvalMode: ApprovalMode.optional(),
    operatorDomains: z.array(Domain).max(50).optional(),
    freeMailDomains: z.array(Domain).max(500).optional(),
    burstWindowMinutes: z.number().int().min(1).max(10_080).optional(),
    defaultDialCode: z
      .string()
      .regex(/^\+[1-9]\d{0,3}$/, 'must be a dialling code, e.g. +91')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');

const Boundary = z
  .object({
    wall: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'must be an ISO local date time'),
    tz: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_+-]+$/, 'must be an IANA zone, e.g. Asia/Kolkata'),
    utc: z.coerce.date(),
  })
  .strict();

/**
 * The sampling module does not own cycles. It owns the sampling facing facts of
 * a cycle: the windows locking is allowed inside, and the minimum the gate is
 * evaluated against. See sampling.policy.ts for why this is a collection here
 * rather than a read of another module's documents.
 */
export const CyclePolicyBody = z
  .object({
    minimumSamplingSize: z.number().int().min(1).max(10_000),
    samplingOpens: Boundary,
    samplingCloses: Boundary,
    assessmentOpens: Boundary,
    assessmentCloses: Boundary,
  })
  .strict();
export type CyclePolicyBody = z.infer<typeof CyclePolicyBody>;

export const CycleIdParam = z.object({ cycleId: Ulid });

export const CyclePolicyView = CyclePolicyBody.extend({
  cycleId: Ulid,
  samplingOpen: z.boolean(),
  assessmentOpen: z.boolean(),
  updatedAt: z.string(),
});
export type CyclePolicyView = z.infer<typeof CyclePolicyView>;

export const AUDIT_ACTIONS = [
  'CONTACT_CREATED',
  'CONTACT_UPDATED',
  'CONTACT_STATUS_CHANGED',
  'CONTACTS_IMPORTED',
  'BATCH_CREATED',
  'BATCH_SELECTION_SET',
  'BATCH_LOCKED',
  'BATCH_CONTACT_ADDED',
  'BATCH_CONTACT_REMOVED',
  'BATCH_CONTACT_CORRECTED',
  'BATCH_APPROVED',
  'BATCH_REJECTED',
  'SETTINGS_UPDATED',
  'CYCLE_POLICY_SET',
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditQuery = z
  .object({
    action: AuditAction.optional(),
    subjectId: Ulid.optional(),
    batchId: Ulid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: Ulid.optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditEntryView = z.object({
  id: Ulid,
  at: z.string(),
  actorUserId: Ulid,
  actorName: z.string(),
  action: AuditAction,
  subjectType: z.enum(['CONTACT', 'BATCH', 'IMPORT', 'SETTINGS', 'CYCLE']),
  subjectId: z.string(),
  batchId: Ulid.nullable(),
  reasonCode: z.string().nullable(),
  detail: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
export type AuditEntryView = z.infer<typeof AuditEntryView>;

export const ExportQuery = z
  .object({
    status: ContactStatus.optional(),
    formScope: FormScope.optional(),
    customerType: CustomerType.optional(),
  })
  .strict();
export type ExportQuery = z.infer<typeof ExportQuery>;
