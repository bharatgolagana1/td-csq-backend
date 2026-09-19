import { z } from 'zod';
import { FormScope, Ulid } from '@csq/contracts';

/**
 * The orgs module owns the three records every other module depends on: the
 * organisation, the person, and the membership that binds them.
 *
 * The membership is its own document rather than a field on either side,
 * because it carries a SET of role classes, a scope and a validity window, and
 * none of those survive being flattened into a foreign key. An ACO SPOC is an
 * administrator and an assessor at the same time; a scalar role cannot say so
 * without inventing a combined role for every pair anyone ever needs.
 */

export const ORG_TYPES = ['PLATFORM', 'GOVERNING_BODY', 'ACO', 'ASSESSOR_FIRM', 'AIRPORT'] as const;
export const OrgType = z.enum(ORG_TYPES);
export type OrgType = z.infer<typeof OrgType>;

/**
 * The types that exist to administer other organisations. A platform
 * capability is honoured only when it was granted inside one of these, so a
 * role class misconfigured in an operator's own organisation cannot quietly
 * become authority over the whole registry.
 */
export const ADMINISTERING_ORG_TYPES: readonly OrgType[] = Object.freeze([
  'PLATFORM',
  'GOVERNING_BODY',
]);

/** Only these may arrive through public self registration. */
export const SELF_REGISTERABLE_TYPES = ['ACO', 'ASSESSOR_FIRM'] as const;
export const SelfRegisterableType = z.enum(SELF_REGISTERABLE_TYPES);

export const ORG_STATES = ['REGISTERED', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED'] as const;
export const OrgState = z.enum(ORG_STATES);
export type OrgState = z.infer<typeof OrgState>;

export const ORG_TRANSITIONS = ['SUBMIT', 'APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE'] as const;
export const OrgTransition = z.enum(ORG_TRANSITIONS);
export type OrgTransition = z.infer<typeof OrgTransition>;

/**
 * The complete state machine. A transition names the states it may start from,
 * so there is no PATCH that can set `state` to anything it likes and no path
 * from REGISTERED straight to ACTIVE that skips a Super Admin.
 */
export const TRANSITION_TABLE: Readonly<
  Record<OrgTransition, { readonly from: readonly OrgState[]; readonly to: OrgState }>
> = Object.freeze({
  SUBMIT: { from: ['REGISTERED'], to: 'PENDING_APPROVAL' },
  APPROVE: { from: ['PENDING_APPROVAL'], to: 'ACTIVE' },
  REJECT: { from: ['PENDING_APPROVAL'], to: 'REGISTERED' },
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  REINSTATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
});

/**
 * AUTO lets an operator lock its own customer sample. SUPER_ADMIN holds every
 * lock for review first. It is set by the platform and never by the operator,
 * because an operator that can switch itself to AUTO has removed the only
 * control over who grades it.
 */
export const SAMPLING_APPROVAL_MODES = ['AUTO', 'SUPER_ADMIN'] as const;
export const SamplingApprovalMode = z.enum(SAMPLING_APPROVAL_MODES);
export type SamplingApprovalMode = z.infer<typeof SamplingApprovalMode>;

export const USER_KINDS = ['STAFF', 'ASSESSOR'] as const;
export const UserKind = z.enum(USER_KINDS);
export type UserKind = z.infer<typeof UserKind>;

/**
 * Deliberately the same two values the kernel's users collection allows. The
 * kernel reads that collection to decide whether an account may authenticate at
 * all, and a status it does not recognise would be read as "not suspended".
 */
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const UserStatus = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof UserStatus>;

/**
 * How wide a membership reaches inside its organisation. ORG_WIDE is everything
 * the organisation owns; the other two carry the ids they are limited to, which
 * is what an assessor loaned to two terminals actually needs.
 */
export const SCOPE_MODES = ['ORG_WIDE', 'TERMINAL', 'ASSIGNMENT'] as const;
export const ScopeMode = z.enum(SCOPE_MODES);
export type ScopeMode = z.infer<typeof ScopeMode>;

/** Role classes are seeded reference data; this is the shape of a code, not a list of them. */
export const RoleClassCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'must be an upper case role class code');

const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*:[a-z][a-z0-9-]*$/;
export const CapabilityCode = z.string().regex(CAPABILITY_RE, 'must look like module.area:verb');

/** Short stable handle used in reports and URLs, so it is fixed at creation. */
export const OrgCode = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, 'must be 2 to 16 upper case letters, digits or hyphens');

export const Email = z.string().trim().toLowerCase().email().max(254);
export const PhoneE164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 number, e.g. +919812345678');

export const CountryCode = z.string().trim().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code');

/** Indian statutory identifiers. Format only: existence is the registrar's business. */
export const Gstin = z
  .string()
  .trim()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'must be a 15 character GSTIN');
export const Cin = z
  .string()
  .trim()
  .regex(/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/, 'must be a 21 character CIN');
export const Pan = z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'must be a 10 character PAN');

export const OrgAddress = z.object({
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  country: CountryCode,
  /** Operating region the governing body reports by, e.g. North or West. */
  region: z.string().trim().min(1).max(80),
});
export type OrgAddress = z.infer<typeof OrgAddress>;

export const RegistrationIds = z.object({
  cin: Cin.nullable().default(null),
  gstin: Gstin.nullable().default(null),
  pan: Pan.nullable().default(null),
});
export type RegistrationIds = z.infer<typeof RegistrationIds>;

export const PrimaryContact = z.object({
  givenName: z.string().trim().min(1).max(80),
  familyName: z.string().trim().min(1).max(80),
  email: Email,
  phoneE164: PhoneE164.nullable().default(null),
  whatsappOptIn: z.boolean().default(false),
});
export type PrimaryContact = z.infer<typeof PrimaryContact>;

const OrgCore = {
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120).nullable().default(null),
  code: OrgCode,
  airportId: Ulid.nullable().default(null),
  address: OrgAddress,
  registrationIds: RegistrationIds.default({ cin: null, gstin: null, pan: null }),
  /**
   * Which form an operator is assessed on. Required for an ACO because it
   * decides whether the answers carry export and import or inbound and
   * outbound, and that cannot be inferred later from the answers themselves.
   */
  formScope: FormScope.nullable().default(null),
};

function requireFormScopeForAco(
  value: { type: string; formScope: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.type === 'ACO' && value.formScope === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['formScope'],
      message: 'an ACO is assessed on the international or the domestic form, so one must be chosen',
    });
  }
}

/** The public application. No principal exists yet, so it creates nothing but the application. */
export const RegisterOrganization = z
  .object({ ...OrgCore, type: SelfRegisterableType, primaryContact: PrimaryContact })
  .strict()
  .superRefine(requireFormScopeForAco);
export type RegisterOrganization = z.infer<typeof RegisterOrganization>;

export const CreateOrganization = z
  .object({
    ...OrgCore,
    type: OrgType,
    samplingApprovalMode: SamplingApprovalMode.default('SUPER_ADMIN'),
    primaryContact: PrimaryContact.nullable().default(null),
  })
  .strict()
  .superRefine(requireFormScopeForAco);
export type CreateOrganization = z.infer<typeof CreateOrganization>;

/**
 * The registry patch. `code`, `type` and `state` are absent on purpose: the
 * code is quoted in published reports, the type decides which role classes are
 * grantable, and the state moves only through the transition table.
 */
export const PatchOrganization = z
  .object({
    legalName: OrgCore.legalName,
    displayName: z.string().trim().min(2).max(120).nullable(),
    airportId: Ulid.nullable(),
    address: OrgAddress,
    registrationIds: RegistrationIds,
    formScope: FormScope.nullable(),
    samplingApprovalMode: SamplingApprovalMode,
    primaryContact: PrimaryContact.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type PatchOrganization = z.infer<typeof PatchOrganization>;

/**
 * What an organisation may change about itself. Narrower than the registry
 * patch by design: samplingApprovalMode is the platform's control over who
 * grades an operator, and formScope decides which instrument it is measured on.
 */
export const PatchOwnOrganization = z
  .object({
    displayName: z.string().trim().min(2).max(120).nullable(),
    address: OrgAddress,
    registrationIds: RegistrationIds,
    primaryContact: PrimaryContact,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type PatchOwnOrganization = z.infer<typeof PatchOwnOrganization>;

export const TransitionOrganization = z
  .object({
    action: OrgTransition,
    /** Recorded on the state history. Required for the two refusals. */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.action === 'REJECT' || v.action === 'SUSPEND') && v.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: `a ${v.action.toLowerCase()} has to say why, because the applicant is told`,
      });
    }
  });
export type TransitionOrganization = z.infer<typeof TransitionOrganization>;

const IsoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const MembershipCore = {
  /**
   * A set, not a scalar, and stored sorted and deduplicated so that two
   * memberships granting the same authority compare equal.
   */
  roleClasses: z
    .array(RoleClassCode)
    .min(1)
    .max(8)
    .transform((values) => [...new Set(values)].sort()),
  scopeMode: ScopeMode.default('ORG_WIDE'),
  scopeIds: z.array(Ulid).max(64).default([]),
  validFrom: IsoInstant.optional(),
  validUntil: IsoInstant.nullable().default(null),
};

function checkScope(
  value: { scopeMode?: ScopeMode; scopeIds?: readonly string[]; validFrom?: Date; validUntil?: Date | null },
  ctx: z.RefinementCtx,
): void {
  const { scopeMode, scopeIds } = value;
  if (scopeMode !== undefined || scopeIds !== undefined) {
    if (scopeMode === undefined || scopeIds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeIds'],
        message: 'scopeMode and scopeIds change together, never one without the other',
      });
    } else if (scopeMode === 'ORG_WIDE' && scopeIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeIds'],
        message: 'an organisation wide membership names no scope ids',
      });
    } else if (scopeMode !== 'ORG_WIDE' && scopeIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeIds'],
        message: `a ${scopeMode} membership has to name at least one id`,
      });
    }
  }
  if (value.validFrom && value.validUntil && value.validUntil <= value.validFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'the validity window has to end after it starts',
    });
  }
}

export const InviteMember = z
  .object({
    ...MembershipCore,
    email: Email,
    givenName: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    kind: UserKind,
    phoneE164: PhoneE164.nullable().default(null),
    whatsappOptIn: z.boolean().default(false),
  })
  .strict()
  .superRefine(checkScope);
export type InviteMember = z.infer<typeof InviteMember>;

export const PatchMember = z
  .object(MembershipCore)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change')
  .superRefine(checkScope);
export type PatchMember = z.infer<typeof PatchMember>;

export const DeactivateMember = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .strict()
  .default({});

export const CreateUser = z
  .object({
    email: Email,
    givenName: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    kind: UserKind,
    phoneE164: PhoneE164.nullable().default(null),
    whatsappOptIn: z.boolean().default(false),
    /** Present when the Keycloak account already exists. */
    kcUserId: z.string().trim().min(8).max(128).optional(),
  })
  .strict();
export type CreateUser = z.infer<typeof CreateUser>;

export const PatchUser = z
  .object({
    givenName: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    phoneE164: PhoneE164.nullable(),
    whatsappOptIn: z.boolean(),
    status: UserStatus,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type PatchUser = z.infer<typeof PatchUser>;

export const LinkIdentity = z
  .object({ kcUserId: z.string().trim().min(8).max(128) })
  .strict();

const Page = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Offset paging, capped. These are administrative lists of hundreds sorted by
   * name or code, which a keyset cursor cannot express, and a cap keeps a deep
   * page from turning into a collection scan.
   */
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  order: z.enum(['asc', 'desc']).default('asc'),
};

/** Anchored, escaped and folded before it reaches Mongo. */
export const SearchTerm = z.string().trim().min(1).max(64);

export const ORG_SORT_FIELDS = ['code', 'legalName', 'state', 'createdAt'] as const;
export const OrgListQuery = z
  .object({
    ...Page,
    sort: z.enum(ORG_SORT_FIELDS).default('code'),
    type: OrgType.optional(),
    state: OrgState.optional(),
    country: CountryCode.optional(),
    region: z.string().trim().min(1).max(80).optional(),
    airportId: Ulid.optional(),
    samplingApprovalMode: SamplingApprovalMode.optional(),
    q: SearchTerm.optional(),
  })
  .strict();
export type OrgListQuery = z.infer<typeof OrgListQuery>;

export const MEMBER_SORT_FIELDS = ['displayName', 'email', 'createdAt', 'validUntil'] as const;
export const MemberListQuery = z
  .object({
    ...Page,
    sort: z.enum(MEMBER_SORT_FIELDS).default('displayName'),
    roleClass: RoleClassCode.optional(),
    scopeMode: ScopeMode.optional(),
    kind: UserKind.optional(),
    includeInactive: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    q: SearchTerm.optional(),
  })
  .strict();
export type MemberListQuery = z.infer<typeof MemberListQuery>;

export const USER_SORT_FIELDS = ['displayName', 'email', 'createdAt'] as const;
export const UserListQuery = z
  .object({
    ...Page,
    sort: z.enum(USER_SORT_FIELDS).default('displayName'),
    kind: UserKind.optional(),
    status: UserStatus.optional(),
    linked: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    q: SearchTerm.optional(),
  })
  .strict();
export type UserListQuery = z.infer<typeof UserListQuery>;

export const OrgIdParam = z.object({ orgId: Ulid });
export const UserIdParam = z.object({ userId: Ulid });
export const MembershipIdParam = z.object({ membershipId: Ulid });

export const OrganizationView = z.object({
  id: Ulid,
  type: OrgType,
  state: OrgState,
  legalName: z.string(),
  displayName: z.string().nullable(),
  code: OrgCode,
  airportId: Ulid.nullable(),
  address: OrgAddress,
  registrationIds: RegistrationIds,
  formScope: FormScope.nullable(),
  samplingApprovalMode: SamplingApprovalMode,
  primaryContact: PrimaryContact.nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrganizationView = z.infer<typeof OrganizationView>;

export const UserView = z.object({
  id: Ulid,
  kind: UserKind,
  email: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  displayName: z.string(),
  phoneE164: z.string().nullable(),
  whatsappOptIn: z.boolean(),
  status: UserStatus,
  /** Null until a Keycloak account is linked, which is when sign in starts working. */
  kcUserId: z.string().nullable(),
  membershipsVersion: z.number().int().min(0),
  createdAt: z.string(),
});
export type UserView = z.infer<typeof UserView>;

export const MemberView = z.object({
  membershipId: Ulid,
  orgId: Ulid,
  user: UserView,
  roleClasses: z.array(RoleClassCode),
  capabilities: z.array(CapabilityCode),
  scopeMode: ScopeMode,
  scopeIds: z.array(Ulid),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
  isActive: z.boolean(),
  /** Whether the access projection currently lets this person in. */
  effective: z.boolean(),
  createdAt: z.string(),
});
export type MemberView = z.infer<typeof MemberView>;

export const MyMembershipView = z.object({
  orgId: Ulid,
  code: OrgCode,
  legalName: z.string(),
  type: OrgType,
  state: OrgState,
  roles: z.array(RoleClassCode),
  capabilities: z.array(CapabilityCode),
  active: z.boolean(),
});
export type MyMembershipView = z.infer<typeof MyMembershipView>;

export interface PageOf<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
    readonly hasMore: boolean;
  };
}

/** The seeded role catalogue. Shape only: the contents live in orgs.roles.json. */
export const RoleDefinitionData = z
  .object({
    code: RoleClassCode,
    label: z.string().min(2).max(80),
    description: z.string().min(10).max(300),
    orgTypes: z.array(OrgType).min(1),
    capabilities: z.array(CapabilityCode).max(64),
    /**
     * Granted to the primary contact when an organisation of this type is
     * approved. Exactly one role class per organisation type carries it,
     * otherwise approval would have to guess who runs the place.
     */
    grantedOnApproval: z.boolean().default(false),
  })
  .strict();
export type RoleDefinitionData = z.infer<typeof RoleDefinitionData>;

export const RoleCatalogue = z.array(RoleDefinitionData).min(1).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${row.code} appears twice` });
    }
    seen.add(row.code);
  }
  for (const type of ORG_TYPES) {
    const defaults = rows.filter((r) => r.grantedOnApproval && r.orgTypes.includes(type));
    if (defaults.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${type} has ${defaults.length} role classes granted on approval, and it may have at most one`,
      });
    }
  }
});
