import { Schema, type Query } from 'mongoose';
import type { FormScope } from '@csq/contracts';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import { fail } from '../../kernel/errors.js';
import {
  APPROVAL_MODES,
  AUDIT_ACTIONS,
  BATCH_STATES,
  CONTACT_SOURCES,
  CONTACT_STATUSES,
  CUSTOMER_TYPES,
  IMPORT_MODES,
  IMPORT_ROW_OUTCOMES,
  IMPORT_ROW_PROBLEMS,
  INTEGRITY_SIGNALS,
  REJECTION_REASON_CODES,
  REVIEW_CHANGE_KINDS,
  REVIEW_REASON_CODES,
  type ApprovalMode,
  type AuditAction,
  type BatchState,
  type ContactSource,
  type ContactStatus,
  type CustomerType,
  type ImportMode,
  type ImportRowOutcome,
  type ImportRowProblem,
  type IntegritySignal,
  type RejectionReasonCode,
  type ReviewChangeKind,
  type ReviewReasonCode,
} from './sampling.contracts.js';

const FORM_SCOPES = ['INTERNATIONAL', 'DOMESTIC'] as const;

/**
 * Collection names are stated rather than left to mongoose's pluraliser, which
 * would produce samplingbatchintegritys. An operator reading a slow query log
 * at two in the morning should not have to guess which model that was.
 */
function named<TDoc>(schema: Schema<TDoc>, collection: string): void {
  schema.set('collection', collection);
}

export interface CustomerContactDoc {
  _id: string;
  name: string;
  company: string;
  /** As typed, for display and for the export. */
  email: string;
  /** Case folded. The dedupe key: one address is one customer in an organisation. */
  emailLower: string;
  /** Case folded company, so search does not need a collation. */
  companyKey: string;
  phoneE164: string | null;
  customerType: CustomerType;
  formScope: FormScope;
  status: ContactStatus;
  source: ContactSource;
  /** The import that last touched this row, for the audit trail. */
  lastImportId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const CustomerContactModel = defineTenantModel<CustomerContactDoc>({
  name: 'CustomerContact',
  definition: {
    name: { type: String, required: true },
    company: { type: String, required: true },
    email: { type: String, required: true },
    emailLower: { type: String, required: true },
    companyKey: { type: String, required: true },
    phoneE164: { type: String, default: null },
    customerType: { type: String, enum: [...CUSTOMER_TYPES], required: true },
    formScope: { type: String, enum: [...FORM_SCOPES], required: true },
    status: { type: String, enum: [...CONTACT_STATUSES], required: true, default: 'ACTIVE' },
    source: { type: String, enum: [...CONTACT_SOURCES], required: true, default: 'MANUAL' },
    lastImportId: { type: String, default: null },
  },
  configure: (schema: Schema<CustomerContactDoc & TenantFields>) => {
    named(schema, 'customer_contacts');
    // dedupe by email within an organisation, and nowhere wider: the same
    // forwarder legitimately appears in the directory of every terminal it uses
    schema.index({ orgId: 1, emailLower: 1 }, { unique: true });
    schema.index({ orgId: 1, status: 1, formScope: 1 });
    schema.index({ orgId: 1, companyKey: 1 });
    // partial, because a null phone is the common case and indexing it would
    // make every phoneless contact look like a duplicate of every other
    schema.index({ orgId: 1, phoneE164: 1 }, { partialFilterExpression: { phoneE164: { $type: 'string' } } });
  },
});

export interface ImportRowDoc {
  line: number;
  outcome: ImportRowOutcome;
  problems: Array<{ column: string; code: ImportRowProblem; message: string }>;
  sanitised: boolean;
  name: string | null;
  company: string | null;
  email: string | null;
  emailLower: string | null;
  phoneE164: string | null;
  customerType: CustomerType | null;
  formScope: FormScope | null;
  /** Set when the address already exists, so the commit knows update from create. */
  existingContactId: string | null;
}

const ImportRowSchema = new Schema<ImportRowDoc>(
  {
    line: { type: Number, required: true },
    outcome: { type: String, enum: [...IMPORT_ROW_OUTCOMES], required: true },
    problems: {
      type: [
        new Schema(
          {
            column: { type: String, required: true },
            code: { type: String, enum: [...IMPORT_ROW_PROBLEMS], required: true },
            message: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    sanitised: { type: Boolean, required: true, default: false },
    name: { type: String, default: null },
    company: { type: String, default: null },
    email: { type: String, default: null },
    emailLower: { type: String, default: null },
    phoneE164: { type: String, default: null },
    customerType: { type: String, enum: [...CUSTOMER_TYPES, null], default: null },
    formScope: { type: String, enum: [...FORM_SCOPES, null], default: null },
    existingContactId: { type: String, default: null },
  },
  { _id: false },
);

export interface ContactImportDoc {
  _id: string;
  state: 'VALIDATED' | 'COMMITTED';
  mode: ImportMode;
  fileName: string | null;
  createdBy: string;
  rows: ImportRowDoc[];
  counts: { total: number; create: number; update: number; skip: number; reject: number; sanitised: number };
  committedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ContactImportModel = defineTenantModel<ContactImportDoc>({
  name: 'ContactImport',
  definition: {
    state: { type: String, enum: ['VALIDATED', 'COMMITTED'], required: true, default: 'VALIDATED' },
    mode: { type: String, enum: [...IMPORT_MODES], required: true },
    fileName: { type: String, default: null },
    createdBy: { type: String, required: true },
    rows: { type: [ImportRowSchema], default: [] },
    counts: {
      total: { type: Number, required: true, default: 0 },
      create: { type: Number, required: true, default: 0 },
      update: { type: Number, required: true, default: 0 },
      skip: { type: Number, required: true, default: 0 },
      reject: { type: Number, required: true, default: 0 },
      sanitised: { type: Number, required: true, default: 0 },
    },
    committedAt: { type: Date, default: null },
  },
  configure: (schema: Schema<ContactImportDoc & TenantFields>) => {
    named(schema, 'contact_imports');
    schema.index({ orgId: 1, state: 1 });
  },
});

export interface LockedContactSnapshot {
  contactId: string;
  email: string;
  company: string;
  customerType: CustomerType;
  formScope: FormScope;
  phoneE164: string | null;
}

export interface ReviewChangeDoc {
  at: Date;
  by: string;
  kind: ReviewChangeKind;
  contactId: string;
  reasonCode: ReviewReasonCode;
  note: string | null;
  /** Populated for CORRECT: which fields of the contact the reviewer changed. */
  fields: string[];
}

export interface LockGateDoc {
  minimumSamplingSize: number;
  eligibleCount: number;
  cumulativeSelectedCount: number;
  selectedCount: number;
  ok: boolean;
  mustSelectAll: boolean;
  shortfall: number;
  reason: 'BELOW_MINIMUM' | 'NOT_ALL_SELECTED' | 'EMPTY_DIRECTORY' | null;
  needed: number;
  explanation: string;
}

export interface SamplingBatchDoc {
  _id: string;
  cycleId: string;
  formScope: FormScope;
  label: string | null;
  state: BatchState;
  /** The live membership. The reviewer may change this after the lock. */
  selection: string[];
  /** Frozen at the lock. The diff is measured against this and nothing else. */
  submitted: string[];
  lockedSnapshot: LockedContactSnapshot[];
  lockedAt: Date | null;
  lockedBy: string | null;
  approvalMode: ApprovalMode | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  rejection: {
    reasonCode: RejectionReasonCode;
    findings: Array<{ contactId: string | null; detail: string }>;
    note: string | null;
  } | null;
  lockGate: LockGateDoc | null;
  reviewChanges: ReviewChangeDoc[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export const SamplingBatchModel = defineTenantModel<SamplingBatchDoc>({
  name: 'SamplingBatch',
  definition: {
    cycleId: { type: String, required: true },
    formScope: { type: String, enum: [...FORM_SCOPES], required: true },
    label: { type: String, default: null },
    state: { type: String, enum: [...BATCH_STATES], required: true, default: 'DRAFT' },
    selection: { type: [String], default: [] },
    submitted: { type: [String], default: [] },
    lockedSnapshot: {
      type: [
        new Schema<LockedContactSnapshot>(
          {
            contactId: { type: String, required: true },
            email: { type: String, required: true },
            company: { type: String, required: true },
            customerType: { type: String, enum: [...CUSTOMER_TYPES], required: true },
            formScope: { type: String, enum: [...FORM_SCOPES], required: true },
            phoneE164: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    approvalMode: { type: String, enum: [...APPROVAL_MODES, null], default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: String, default: null },
    rejection: {
      type: new Schema(
        {
          reasonCode: { type: String, enum: [...REJECTION_REASON_CODES], required: true },
          findings: {
            type: [
              new Schema(
                { contactId: { type: String, default: null }, detail: { type: String, required: true } },
                { _id: false },
              ),
            ],
            default: [],
          },
          note: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    lockGate: {
      type: new Schema<LockGateDoc>(
        {
          minimumSamplingSize: { type: Number, required: true },
          eligibleCount: { type: Number, required: true },
          cumulativeSelectedCount: { type: Number, required: true },
          selectedCount: { type: Number, required: true },
          ok: { type: Boolean, required: true },
          mustSelectAll: { type: Boolean, required: true },
          shortfall: { type: Number, required: true },
          reason: { type: String, default: null },
          needed: { type: Number, required: true },
          explanation: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    reviewChanges: {
      type: [
        new Schema<ReviewChangeDoc>(
          {
            at: { type: Date, required: true },
            by: { type: String, required: true },
            kind: { type: String, enum: [...REVIEW_CHANGE_KINDS], required: true },
            contactId: { type: String, required: true },
            reasonCode: { type: String, enum: [...REVIEW_REASON_CODES], required: true },
            note: { type: String, default: null },
            fields: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdBy: { type: String, required: true },
  },
  configure: (schema: Schema<SamplingBatchDoc & TenantFields>) => {
    named(schema, 'sampling_batches');
    schema.index({ orgId: 1, cycleId: 1, state: 1 });
    schema.index({ orgId: 1, state: 1 });
  },
});

export interface IntegrityOccurrenceDoc {
  signal: IntegritySignal;
  count: number;
  denominator: number;
  contactIds: string[];
  detail: Record<string, string | number>;
}

export interface BatchIntegrityDoc {
  _id: string;
  batchId: string;
  cycleId: string;
  observedAt: Date;
  contactsConsidered: number;
  occurrences: IntegrityOccurrenceDoc[];
  createdAt: Date;
  updatedAt: Date;
}

export const BatchIntegrityModel = defineTenantModel<BatchIntegrityDoc>({
  name: 'SamplingBatchIntegrity',
  definition: {
    batchId: { type: String, required: true },
    cycleId: { type: String, required: true },
    observedAt: { type: Date, required: true },
    contactsConsidered: { type: Number, required: true, default: 0 },
    occurrences: {
      type: [
        new Schema<IntegrityOccurrenceDoc>(
          {
            signal: { type: String, enum: [...INTEGRITY_SIGNALS], required: true },
            count: { type: Number, required: true },
            denominator: { type: Number, required: true },
            contactIds: { type: [String], default: [] },
            // Mixed, because what an observation needs to record differs per
            // signal and inventing a common shape now would constrain the fit
            detail: { type: Schema.Types.Mixed, default: {} },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  configure: (schema: Schema<BatchIntegrityDoc & TenantFields>) => {
    named(schema, 'sampling_batch_integrity');
    schema.index({ orgId: 1, batchId: 1 }, { unique: true });
  },
});

export interface SamplingAuditDoc {
  _id: string;
  at: Date;
  actorUserId: string;
  actorName: string;
  action: AuditAction;
  subjectType: 'CONTACT' | 'BATCH' | 'IMPORT' | 'SETTINGS' | 'CYCLE';
  subjectId: string;
  batchId: string | null;
  reasonCode: string | null;
  detail: Record<string, string | number | boolean>;
  createdAt: Date;
  updatedAt: Date;
}

const APPEND_ONLY_HOOKS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

export const SamplingAuditModel = defineTenantModel<SamplingAuditDoc>({
  name: 'SamplingAuditEntry',
  definition: {
    at: { type: Date, required: true },
    actorUserId: { type: String, required: true },
    actorName: { type: String, required: true },
    action: { type: String, enum: [...AUDIT_ACTIONS], required: true },
    subjectType: { type: String, enum: ['CONTACT', 'BATCH', 'IMPORT', 'SETTINGS', 'CYCLE'], required: true },
    subjectId: { type: String, required: true },
    batchId: { type: String, default: null },
    reasonCode: { type: String, default: null },
    detail: { type: Schema.Types.Mixed, default: {} },
  },
  configure: (schema: Schema<SamplingAuditDoc & TenantFields>) => {
    named(schema, 'sampling_audit');
    // _id is a ULID, so it is also the time ordering and the pagination cursor
    schema.index({ orgId: 1, _id: -1 });
    schema.index({ orgId: 1, batchId: 1, _id: -1 });
    schema.index({ orgId: 1, action: 1, _id: -1 });
    schema.index({ orgId: 1, subjectId: 1, _id: -1 });

    // An audit trail that can be edited is a story, not evidence. The trail is
    // append only in the schema rather than by convention, so a future handler
    // that tries to tidy an entry fails loudly instead of quietly rewriting it.
    schema.pre<Query<unknown, unknown>>([...APPEND_ONLY_HOOKS], function (next) {
      next(fail('INTERNAL', 'The sampling audit trail is append only'));
    });
  },
});

export interface SamplingSettingsDoc {
  _id: string;
  approvalMode: ApprovalMode;
  operatorDomains: string[];
  freeMailDomains: string[];
  burstWindowMinutes: number;
  defaultDialCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SamplingSettingsModel = defineTenantModel<SamplingSettingsDoc>({
  name: 'SamplingSettings',
  uniqueTenant: true,
  definition: {
    // review required until an administrator decides otherwise: the weaker
    // setting is the one that should have to be chosen deliberately
    approvalMode: { type: String, enum: [...APPROVAL_MODES], required: true, default: 'SUPER_ADMIN' },
    operatorDomains: { type: [String], default: [] },
    freeMailDomains: { type: [String], default: [] },
    burstWindowMinutes: { type: Number, required: true, default: 60 },
    defaultDialCode: { type: String, default: null },
  },
  configure: (schema: Schema<SamplingSettingsDoc & TenantFields>) => {
    named(schema, 'sampling_settings');
  },
});

export interface CycleBoundaryDoc {
  wall: string;
  tz: string;
  utc: Date;
}

const BoundarySchema = new Schema<CycleBoundaryDoc>(
  {
    wall: { type: String, required: true },
    tz: { type: String, required: true },
    utc: { type: Date, required: true },
  },
  { _id: false },
);

export interface CyclePolicyDoc {
  _id: string;
  cycleId: string;
  minimumSamplingSize: number;
  samplingOpens: CycleBoundaryDoc;
  samplingCloses: CycleBoundaryDoc;
  assessmentOpens: CycleBoundaryDoc;
  assessmentCloses: CycleBoundaryDoc;
  createdAt: Date;
  updatedAt: Date;
}

export const CyclePolicyModel = defineTenantModel<CyclePolicyDoc>({
  name: 'SamplingCyclePolicy',
  definition: {
    cycleId: { type: String, required: true },
    minimumSamplingSize: { type: Number, required: true },
    samplingOpens: { type: BoundarySchema, required: true },
    samplingCloses: { type: BoundarySchema, required: true },
    assessmentOpens: { type: BoundarySchema, required: true },
    assessmentCloses: { type: BoundarySchema, required: true },
  },
  configure: (schema: Schema<CyclePolicyDoc & TenantFields>) => {
    named(schema, 'sampling_cycle_policies');
    schema.index({ orgId: 1, cycleId: 1 }, { unique: true });
  },
});
