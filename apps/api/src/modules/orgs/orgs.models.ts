import { Schema, model, type HydratedDocument, type Model , models } from 'mongoose';
import { newId } from '../../kernel/ids.js';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import {
  ORG_STATES,
  ORG_TYPES,
  SAMPLING_APPROVAL_MODES,
  SCOPE_MODES,
  USER_KINDS,
  USER_STATUSES,
  type OrgAddress,
  type OrgState,
  type OrgTransition,
  type OrgType,
  type PrimaryContact,
  type RegistrationIds,
  type SamplingApprovalMode,
  type ScopeMode,
  type UserKind,
  type UserStatus,
} from './orgs.contracts.js';
import type { FormScope } from '@csq/contracts';

/**
 * Organisations and people are not tenant scoped, for the same reason the
 * kernel's identity collections are not: a person may hold memberships in
 * several organisations, and a collection filtered by one of them could not
 * represent that. Memberships are tenant scoped, because a membership belongs
 * to exactly one organisation and that is the whole point of it.
 */

const AddressSchema = new Schema<OrgAddress>(
  {
    city: { type: String, required: true },
    state: { type: String, required: true },
    country: { type: String, required: true },
    region: { type: String, required: true },
  },
  { _id: false },
);

const RegistrationIdsSchema = new Schema<RegistrationIds>(
  {
    cin: { type: String, default: null },
    gstin: { type: String, default: null },
    pan: { type: String, default: null },
  },
  { _id: false },
);

const PrimaryContactSchema = new Schema<PrimaryContact>(
  {
    givenName: { type: String, required: true },
    familyName: { type: String, required: true },
    email: { type: String, required: true },
    phoneE164: { type: String, default: null },
    whatsappOptIn: { type: Boolean, default: false },
  },
  { _id: false },
);

export interface StateChange {
  from: OrgState;
  to: OrgState;
  action: OrgTransition;
  at: Date;
  /** The user id that asked for it, or null when the applicant did. */
  by: string | null;
  reason: string | null;
}

const StateChangeSchema = new Schema<StateChange>(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    action: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

export interface OrganizationDoc {
  _id: string;
  type: OrgType;
  state: OrgState;
  legalName: string;
  /** Case folded, so the registry search can use an index instead of a scan. */
  legalNameLower: string;
  displayName: string | null;
  code: string;
  airportId: string | null;
  address: OrgAddress;
  registrationIds: RegistrationIds;
  formScope: FormScope | null;
  samplingApprovalMode: SamplingApprovalMode;
  primaryContact: PrimaryContact | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  stateHistory: StateChange[];
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<OrganizationDoc>(
  {
    _id: { type: String, default: newId },
    type: { type: String, enum: [...ORG_TYPES], required: true },
    state: { type: String, enum: [...ORG_STATES], required: true, default: 'REGISTERED' },
    legalName: { type: String, required: true },
    legalNameLower: { type: String, required: true },
    displayName: { type: String, default: null },
    // quoted in published reports and in every URL, so it is set once at
    // creation and never edited: a renamed code is a different organisation
    code: { type: String, required: true, immutable: true },
    airportId: { type: String, default: null },
    address: { type: AddressSchema, required: true },
    registrationIds: { type: RegistrationIdsSchema, required: true },
    formScope: { type: String, default: null },
    samplingApprovalMode: {
      type: String,
      enum: [...SAMPLING_APPROVAL_MODES],
      required: true,
      default: 'SUPER_ADMIN',
    },
    primaryContact: { type: PrimaryContactSchema, default: null },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    stateHistory: { type: [StateChangeSchema], default: [] },
  },
  { timestamps: true },
);

OrganizationSchema.index({ code: 1 }, { unique: true });
OrganizationSchema.index({ type: 1, state: 1, code: 1 });
OrganizationSchema.index({ legalNameLower: 1 });
OrganizationSchema.index({ airportId: 1 }, { sparse: true });
OrganizationSchema.index({ 'address.country': 1, 'address.region': 1 });

/**
 * The kernel declares an Organisation model of its own that nothing reads. This
 * is the registry the product actually needs, in its own collection, because
 * two models over one collection would fight over that collection's indexes
 * every time mongoose.syncIndexes runs at boot.
 */
export const OrganizationModel: Model<OrganizationDoc> =
  (models['CsqOrganization'] as Model<OrganizationDoc> | undefined) ??
  model<OrganizationDoc>(
    'CsqOrganization',
  OrganizationSchema,
  'organizations',
);
export type OrganizationDocument = HydratedDocument<OrganizationDoc>;

/**
 * The kernel's users collection has a non sparse unique index on `subject`, so
 * a second unlinked account would collide on null. An account waiting for its
 * Keycloak identity therefore carries a unique placeholder instead. No token
 * can present one: a Keycloak subject is a UUID and never contains a colon.
 */
export const UNLINKED_SUBJECT_PREFIX = 'pending:';

export function unlinkedSubject(): string {
  return `${UNLINKED_SUBJECT_PREFIX}${newId()}`;
}

export function isLinked(subject: string): boolean {
  return !subject.startsWith(UNLINKED_SUBJECT_PREFIX);
}

export interface OrgUserDoc {
  _id: string;
  kind: UserKind;
  email: string;
  /** The identity key. One person is one row, whatever they are called. */
  emailLower: string;
  /** The Keycloak "sub" once linked, a placeholder before that. */
  subject: string;
  givenName: string;
  familyName: string;
  displayName: string;
  displayNameLower: string;
  phoneE164: string | null;
  whatsappOptIn: boolean;
  status: UserStatus;
  /** Bumped every time this person's access changes. Stale caches can see it. */
  membershipsVersion: number;
  lastProjectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const OrgUserSchema = new Schema<OrgUserDoc>(
  {
    _id: { type: String, default: newId },
    kind: { type: String, enum: [...USER_KINDS], required: true },
    email: { type: String, required: true },
    emailLower: { type: String, required: true },
    subject: { type: String, required: true },
    givenName: { type: String, required: true },
    familyName: { type: String, required: true },
    displayName: { type: String, required: true },
    displayNameLower: { type: String, required: true },
    phoneE164: { type: String, default: null },
    whatsappOptIn: { type: Boolean, required: true, default: false },
    status: { type: String, enum: [...USER_STATUSES], required: true, default: 'ACTIVE' },
    membershipsVersion: { type: Number, required: true, default: 0 },
    lastProjectedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

OrgUserSchema.index({ emailLower: 1 }, { unique: true });
OrgUserSchema.index({ subject: 1 }, { unique: true });
OrgUserSchema.index({ kind: 1, status: 1, displayNameLower: 1 });
OrgUserSchema.index({ displayNameLower: 1 });

export const OrgUserModel: Model<OrgUserDoc> =
  (models['OrgUser'] as Model<OrgUserDoc> | undefined) ??
  model<OrgUserDoc>('OrgUser', OrgUserSchema, 'org_users');
export type OrgUserDocument = HydratedDocument<OrgUserDoc>;

export interface MembershipDoc {
  _id: string;
  userId: string;
  /** A set: sorted and deduplicated on the way in. */
  roleClasses: string[];
  scopeMode: ScopeMode;
  scopeIds: string[];
  validFrom: Date;
  validUntil: Date | null;
  /** The administrative flag, and the discriminator the partial unique index uses. */
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedReason: string | null;
  invitedBy: string | null;
  /** What the access projection last wrote, so a sweep can find what has drifted. */
  projectedActive: boolean;
  projectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MembershipModel = defineTenantModel<MembershipDoc>({
  name: 'Membership',
  definition: {
    userId: { type: String, required: true },
    roleClasses: { type: [String], required: true },
    scopeMode: { type: String, enum: [...SCOPE_MODES], required: true, default: 'ORG_WIDE' },
    scopeIds: { type: [String], default: [] },
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, default: null },
    isActive: { type: Boolean, required: true, default: true },
    deactivatedAt: { type: Date, default: null },
    deactivatedReason: { type: String, default: null },
    invitedBy: { type: String, default: null },
    projectedActive: { type: Boolean, required: true, default: false },
    projectedAt: { type: Date, default: null },
  },
  configure: (schema: Schema<MembershipDoc & TenantFields>) => {
    // one live membership per person per organisation. Partial on isActive, so
    // deactivating frees the slot and rejoining is a new row with its own history
    schema.index({ orgId: 1, userId: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
    schema.index({ orgId: 1, isActive: 1, createdAt: -1 });
    schema.index({ orgId: 1, roleClasses: 1 });
    // the two sweeps below are cross organisation by nature, so they are single
    // field indexes rather than compound ones that would have to lead with orgId
    schema.index({ userId: 1 });
    schema.index({ validUntil: 1 });
    schema.index({ projectedActive: 1 });
  },
});

export interface RoleDefinitionDoc {
  /** The role class code itself. A natural key needs no surrogate. */
  _id: string;
  label: string;
  description: string;
  orgTypes: OrgType[];
  capabilities: string[];
  grantedOnApproval: boolean;
  updatedAt: Date;
}

const RoleDefinitionSchema = new Schema<RoleDefinitionDoc>(
  {
    _id: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    orgTypes: { type: [String], required: true },
    capabilities: { type: [String], required: true },
    grantedOnApproval: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

RoleDefinitionSchema.index({ orgTypes: 1 });
RoleDefinitionSchema.index({ grantedOnApproval: 1 });

/**
 * Platform reference data, identical for every tenant and therefore not tenant
 * scoped: a filtered role catalogue would make every organisation's roles
 * invisible to it. Seeded by orgs.seed.ts, never written by a request handler.
 */
export const RoleDefinitionModel: Model<RoleDefinitionDoc> =
  (models['RoleDefinition'] as Model<RoleDefinitionDoc> | undefined) ??
  model<RoleDefinitionDoc>(
    'RoleDefinition',
  RoleDefinitionSchema,
  'role_definitions',
);
