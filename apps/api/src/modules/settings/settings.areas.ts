import { z } from 'zod';
import {
  DEFAULT_REVEAL_ON,
  FormScope,
  MIN_COVERAGE_BP_TO_PUBLISH,
  MIN_RESPONSES_TO_PUBLISH,
  RatingKey,
  Ulid,
} from '@csq/contracts';

/**
 * The settings catalogue, as one typed registry.
 *
 * Legal Genius renders its settings hub from an array of areas and hides the
 * ones the signed-in user has no permission for. That filter belongs on the
 * server: a frontend that decides for itself what to show has already been
 * handed the list of everything that exists. Here the catalogue endpoint
 * returns only the areas the caller may open, so adding an area is a change to
 * this file and nothing else, and no frontend release is needed to expose it.
 *
 * Each area owns its payload, its zod schema and its defaults. Defaults living
 * here rather than in the database is what lets a missing document read as a
 * complete, valid settings object instead of failing or returning nulls the
 * frontend has to second-guess.
 */

export const SETTINGS_BASE_PATH = '/v1/settings';

/**
 * Every capability this module invents, in one closed list, so an area cannot
 * name a capability the module never declares to the router. A typo is a
 * compile error here and a boot failure in the route policy check.
 */
export const SETTINGS_CAPABILITIES = [
  'settings:read',
  'settings:write',
  'settings.users:read',
  'settings.users:write',
  'settings.lists:write',
  'settings.platform:read',
  'settings.platform:write',
] as const;
export type SettingsCapability = (typeof SETTINGS_CAPABILITIES)[number];

/**
 * GLOBAL  one document for the whole platform, written by ACFI staff
 * ORG     one document per organisation
 * SELF    one document per person, the same in every organisation they belong to
 */
export type AreaScope = 'GLOBAL' | 'ORG' | 'SELF';

export const ORG_AREA_KEYS = ['organisation', 'users-and-roles', 'notifications'] as const;
export const SELF_AREA_KEYS = ['my-account', 'navigation', 'display'] as const;
export const GLOBAL_AREA_KEYS = ['question-bank', 'weightage', 'approval-mode'] as const;

export type OrgAreaKey = (typeof ORG_AREA_KEYS)[number];
export type SelfAreaKey = (typeof SELF_AREA_KEYS)[number];
export type GlobalAreaKey = (typeof GLOBAL_AREA_KEYS)[number];
export type AreaKey = OrgAreaKey | SelfAreaKey | GlobalAreaKey;

/** A settings payload is sections of flat fields. The sections are what a PATCH names. */
export type AreaValue = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface AreaDefinition {
  readonly key: AreaKey;
  readonly scope: AreaScope;
  readonly title: string;
  readonly description: string;
  /** A token the frontend maps to its own icon set. Never a URL or a component. */
  readonly icon: string;
  /** Where the frontend routes to. The API path is derived from scope and key. */
  readonly route: string;
  readonly readCapability: SettingsCapability | null;
  readonly writeCapability: SettingsCapability | null;
  readonly sections: Readonly<Record<string, z.AnyZodObject>>;
  readonly defaults: Readonly<Record<string, unknown>>;
}

interface AreaSpec<S extends Record<string, z.AnyZodObject>> {
  readonly key: AreaKey;
  readonly scope: AreaScope;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly route: string;
  readonly readCapability: SettingsCapability | null;
  readonly writeCapability: SettingsCapability | null;
  readonly sections: S;
  /** Checked against the section schemas at the definition site, and again at boot. */
  readonly defaults: { readonly [K in keyof S]: z.infer<S[K]> };
}

function defineArea<S extends Record<string, z.AnyZodObject>>(spec: AreaSpec<S>): AreaDefinition {
  return spec;
}

const Nullable = {
  text: (max: number) => z.string().min(1).max(max).nullable(),
  email: () => z.string().email().max(160).nullable(),
  phone: () => z.string().min(6).max(24).nullable(),
};

/** An IANA zone, because every cycle boundary an administrator types is read in one. */
const Timezone = z.string().regex(/^[A-Za-z_]+\/[A-Za-z_+-]+$/, 'must be an IANA zone, e.g. Asia/Kolkata');
const Locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'must be a locale such as en or en-IN');
const IataCode = z.string().regex(/^[A-Z]{3}$/, 'must be a three letter IATA code');
const EmailDomain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a domain such as example.com');

const organisation = defineArea({
  key: 'organisation',
  scope: 'ORG',
  title: 'Organisation',
  description: 'Legal details, the single point of contact for assessments, and which CSQ form this terminal is assessed on.',
  icon: 'BUSINESS',
  route: '/settings/organisation',
  readCapability: 'settings:read',
  writeCapability: 'settings:write',
  sections: {
    details: z.object({
      legalName: Nullable.text(200),
      tradingName: Nullable.text(120),
      registrationNumber: Nullable.text(32),
      addressLine1: Nullable.text(160),
      addressLine2: Nullable.text(160),
      city: Nullable.text(80),
      state: Nullable.text(80),
      postalCode: Nullable.text(16),
      country: Nullable.text(80),
    }),
    /**
     * One named person answers for the assessment. A shared mailbox here is how
     * a reminder ends up read by nobody, so the name is stored beside the address.
     */
    spoc: z.object({
      name: Nullable.text(120),
      designation: Nullable.text(120),
      email: Nullable.email(),
      phone: Nullable.phone(),
    }),
    formScope: z.object({
      /** INTERNATIONAL is rated export and import, DOMESTIC inbound and outbound. */
      scope: FormScope.nullable(),
      terminalCodes: z.array(IataCode).max(20),
      timezone: Timezone.nullable(),
      locale: Locale.nullable(),
    }),
  },
  defaults: {
    details: {
      legalName: null,
      tradingName: null,
      registrationNumber: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    },
    spoc: { name: null, designation: null, email: null, phone: null },
    // nothing is assumed about a terminal until somebody states it: guessing
    // INTERNATIONAL would silently put an inbound answer on an export form
    formScope: { scope: null, terminalCodes: [], timezone: null, locale: null },
  },
});

const usersAndRoles = defineArea({
  key: 'users-and-roles',
  scope: 'ORG',
  title: 'Users and roles',
  description: 'How people join this organisation, what they can do on arrival, and when an unused account goes quiet.',
  icon: 'GROUPS',
  route: '/settings/users',
  readCapability: 'settings.users:read',
  writeCapability: 'settings.users:write',
  sections: {
    invitations: z.object({
      allowSelfService: z.boolean(),
      defaultRoles: z.array(z.string().min(1).max(40)).max(8),
      /** Empty means any address may be invited. A populated list is a closed door. */
      emailDomainAllowlist: z.array(EmailDomain).max(20),
    }),
    access: z.object({
      sessionIdleMinutes: z.number().int().min(5).max(1440),
      deactivateAfterDaysInactive: z.number().int().min(30).max(365).nullable(),
      requireTwoPersonRoleChange: z.boolean(),
    }),
  },
  defaults: {
    // self service invitations default off: an assessment's audience decides
    // whose answers count, so who may join is not a convenience setting
    invitations: { allowSelfService: false, defaultRoles: [], emailDomainAllowlist: [] },
    access: { sessionIdleMinutes: 60, deactivateAfterDaysInactive: null, requireTwoPersonRoleChange: false },
  },
});

const notifications = defineArea({
  key: 'notifications',
  scope: 'ORG',
  title: 'Notifications',
  description: 'Which channels this organisation uses, when assessment reminders go out, and where an unanswered cycle escalates.',
  icon: 'NOTIFICATIONS',
  route: '/settings/notifications',
  readCapability: 'settings:read',
  writeCapability: 'settings:write',
  sections: {
    channels: z.object({
      email: z.boolean(),
      whatsapp: z.boolean(),
      sms: z.boolean(),
    }),
    reminders: z.object({
      /** Days before the window closes. Six is already more nagging than anyone reads. */
      daysBeforeClose: z.array(z.number().int().min(1).max(60)).max(6),
      dailyDigestHourLocal: z.number().int().min(0).max(23).nullable(),
      escalationEmail: Nullable.email(),
    }),
  },
  defaults: {
    // invitations are email first, so email off would silence the whole cycle
    channels: { email: true, whatsapp: false, sms: false },
    reminders: { daysBeforeClose: [], dailyDigestHourLocal: null, escalationEmail: null },
  },
});

const myAccount = defineArea({
  key: 'my-account',
  scope: 'SELF',
  title: 'My account',
  description: 'Your name and contact details, the language and formats you read the app in, and how it may reach you.',
  icon: 'ACCOUNT',
  route: '/settings/my-account',
  readCapability: null,
  writeCapability: null,
  sections: {
    /**
     * The identity provider owns the login name. What is kept here is what this
     * person wants to be called inside CSQ, which is not the same thing and is
     * not Keycloak's to answer.
     */
    profile: z.object({
      preferredName: Nullable.text(120),
      designation: Nullable.text(120),
      phone: Nullable.phone(),
    }),
    locale: z.object({
      language: Locale,
      timezone: Timezone.nullable(),
      dateFormat: z.string().min(3).max(24),
      numberFormat: z.enum(['IN', 'INTERNATIONAL']),
    }),
    notificationChannels: z.object({
      email: z.boolean(),
      whatsapp: z.boolean(),
      sms: z.boolean(),
      quietHoursStartLocal: z.number().int().min(0).max(23).nullable(),
      quietHoursEndLocal: z.number().int().min(0).max(23).nullable(),
    }),
  },
  defaults: {
    profile: { preferredName: null, designation: null, phone: null },
    locale: { language: 'en-IN', timezone: null, dateFormat: 'DD MMM YYYY', numberFormat: 'IN' },
    notificationChannels: {
      email: true,
      whatsapp: false,
      sms: false,
      quietHoursStartLocal: null,
      quietHoursEndLocal: null,
    },
  },
});

const navigation = defineArea({
  key: 'navigation',
  scope: 'SELF',
  title: 'Navigation',
  description: 'Hide the sidebar entries you do not use and choose where the app opens. This hides entries; it never changes what you may do.',
  icon: 'NAVIGATION',
  route: '/settings/navigation',
  readCapability: null,
  writeCapability: null,
  sections: {
    /**
     * Hiding is display only. A hidden entry whose capability the caller holds
     * is still reachable by URL, and a visible entry they do not hold is still
     * refused, because authority is the membership and never the menu.
     */
    visibility: z.object({ hiddenKeys: z.array(z.string().min(1).max(40)).max(60) }),
    order: z.object({ keys: z.array(z.string().min(1).max(40)).max(60) }),
    landing: z.object({ path: z.string().startsWith('/').max(120) }),
  },
  defaults: {
    visibility: { hiddenKeys: [] },
    order: { keys: [] },
    landing: { path: '/' },
  },
});

const display = defineArea({
  key: 'display',
  scope: 'SELF',
  title: 'Display preferences',
  description: 'Density, theme, table size and what the dashboard leads with.',
  icon: 'DISPLAY',
  route: '/settings/display',
  readCapability: null,
  writeCapability: null,
  sections: {
    layout: z.object({
      density: z.enum(['COMFORTABLE', 'COMPACT']),
      theme: z.enum(['SYSTEM', 'LIGHT', 'DARK']),
    }),
    tables: z.object({
      rowsPerPage: z.number().int().min(10).max(200),
      stickyHeader: z.boolean(),
    }),
    dashboard: z.object({
      showSelfVsCustomerGap: z.boolean(),
      defaultCycleView: z.enum(['CURRENT', 'LATEST_PUBLISHED']),
    }),
  },
  defaults: {
    layout: { density: 'COMFORTABLE', theme: 'SYSTEM' },
    tables: { rowsPerPage: 25, stickyHeader: true },
    // the gap between the self score and the customer score is the most useful
    // number this system produces, so it is on until somebody turns it off
    dashboard: { showSelfVsCustomerGap: true, defaultCycleView: 'CURRENT' },
  },
});

const questionBank = defineArea({
  key: 'question-bank',
  scope: 'GLOBAL',
  title: 'Question bank',
  description: 'How a question bank version is approved and published, and the limits an author works inside.',
  icon: 'QUESTION_BANK',
  route: '/settings/platform/question-bank',
  readCapability: 'settings.platform:read',
  writeCapability: 'settings.platform:write',
  sections: {
    publication: z.object({
      requireTwoPersonApproval: z.boolean(),
      allowDraftPreview: z.boolean(),
      /** Which ratings reveal the follow-up questions. See the H4 decision. */
      revealFollowUpsOn: z.array(RatingKey).max(6),
    }),
    authoring: z.object({
      /** Codes are ordinal free: ACFI.INFRA.TC_BC_GENERATION, never ACFI.1.7. */
      codePrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,15}$/, 'must be an upper case code prefix'),
      // the wire contract accepts at most 16 follow ups and 32 options per
      // answer, so a larger limit here would only produce questions the API
      // then refuses to accept an answer to
      maxFollowUpsPerQuestion: z.number().int().min(0).max(16),
      maxOptionsPerQuestion: z.number().int().min(0).max(32),
    }),
  },
  defaults: {
    publication: {
      requireTwoPersonApproval: true,
      allowDraftPreview: true,
      revealFollowUpsOn: [...DEFAULT_REVEAL_ON],
    },
    authoring: { codePrefix: 'ACFI', maxFollowUpsPerQuestion: 16, maxOptionsPerQuestion: 32 },
  },
});

const weightage = defineArea({
  key: 'weightage',
  scope: 'GLOBAL',
  title: 'Weightage',
  description: 'The active weighting profile and the thresholds below which a score is reported but not published.',
  icon: 'WEIGHTS',
  route: '/settings/platform/weightage',
  readCapability: 'settings.platform:read',
  writeCapability: 'settings.platform:write',
  sections: {
    profile: z.object({
      activeProfileId: Ulid.nullable(),
      allowOrganisationOverride: z.boolean(),
    }),
    publication: z.object({
      minResponsesToPublish: z.number().int().min(1).max(100),
      /** Basis points of instrument weight that must be answered, 0 to 10000. */
      minCoverageBp: z.number().int().min(0).max(10_000),
      applyMarketShare: z.boolean(),
    }),
  },
  defaults: {
    // no profile is active until one is published: scoring against a guessed
    // profile would produce a reproducible looking number from nothing
    profile: { activeProfileId: null, allowOrganisationOverride: false },
    publication: {
      // the published thresholds are the contract's, read from it rather than
      // typed a second time here where the two could drift apart
      minResponsesToPublish: MIN_RESPONSES_TO_PUBLISH,
      minCoverageBp: MIN_COVERAGE_BP_TO_PUBLISH,
      applyMarketShare: false,
    },
  },
});

const approvalMode = defineArea({
  key: 'approval-mode',
  scope: 'GLOBAL',
  title: 'Approval mode',
  description: 'Who signs off a completed assessment before it scores, and whether a published cycle can be reopened.',
  icon: 'APPROVALS',
  route: '/settings/platform/approval-mode',
  readCapability: 'settings.platform:read',
  writeCapability: 'settings.platform:write',
  sections: {
    assessment: z.object({
      mode: z.enum(['AUTOMATIC', 'ACFI_REVIEW', 'TWO_PERSON']),
      escalationHours: z.number().int().min(1).max(720),
    }),
    reopen: z.object({
      allowAfterPublication: z.boolean(),
      maxReopensPerCycle: z.number().int().min(0).max(10),
    }),
  },
  defaults: {
    // a rating that publishes with nobody looking at it is the failure mode the
    // standard cannot recover from, so review is the default and not automatic
    assessment: { mode: 'ACFI_REVIEW', escalationHours: 72 },
    reopen: { allowAfterPublication: false, maxReopensPerCycle: 1 },
  },
});

export const AREAS: Readonly<Record<AreaKey, AreaDefinition>> = Object.freeze({
  organisation,
  'users-and-roles': usersAndRoles,
  notifications,
  'my-account': myAccount,
  navigation,
  display,
  'question-bank': questionBank,
  weightage,
  'approval-mode': approvalMode,
});

/**
 * An area that is a screen rather than a document: the curated lists have their
 * own endpoints because a list is a collection, not a settings payload. It is
 * still part of the catalogue, because a hub that omits half the settings is
 * not a hub.
 */
export interface LinkArea {
  readonly key: string;
  readonly scope: AreaScope;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly route: string;
  readonly api: string;
  readonly readCapability: SettingsCapability | null;
  readonly writeCapability: SettingsCapability | null;
}

export const LINK_AREAS: readonly LinkArea[] = Object.freeze([
  {
    key: 'lists',
    scope: 'ORG',
    title: 'Lists',
    description: 'The named lists this organisation curates for itself: contact tags, customer segments, decline reasons and terminal areas.',
    icon: 'LISTS',
    route: '/settings/lists',
    api: `${SETTINGS_BASE_PATH}/lists`,
    readCapability: 'settings:read',
    writeCapability: 'settings.lists:write',
  },
]);

const API_PREFIX: Readonly<Record<AreaScope, string>> = Object.freeze({
  ORG: `${SETTINGS_BASE_PATH}/org`,
  SELF: `${SETTINGS_BASE_PATH}/me`,
  GLOBAL: `${SETTINGS_BASE_PATH}/platform`,
});

/** The endpoint that serves an area, so the frontend never builds the path itself. */
export function apiPathOf(area: AreaDefinition): string {
  return `${API_PREFIX[area.scope]}/${area.key}`;
}

export function areaOf(key: AreaKey): AreaDefinition {
  const area = AREAS[key];
  return area;
}

export const ALL_AREAS: readonly AreaDefinition[] = Object.freeze(Object.values(AREAS));

const fullSchemas = new Map<string, z.ZodType<unknown>>();
const patchSchemas = new Map<string, z.ZodType<unknown>>();

/** Every section, every field, nothing else. What a stored value must satisfy. */
export function fullSchemaOf(area: AreaDefinition): z.ZodType<unknown> {
  const cached = fullSchemas.get(area.key);
  if (cached) return cached;
  const built = z.object({ ...area.sections }).strict();
  fullSchemas.set(area.key, built);
  return built;
}

/**
 * A patch names the sections it touches and, inside them, only the fields it
 * changes. Unknown sections and unknown fields are rejected rather than
 * ignored, because a silently dropped field is a bug report from a user who
 * watched their setting not save.
 */
export function patchSchemaOf(area: AreaDefinition): z.ZodType<unknown> {
  const cached = patchSchemas.get(area.key);
  if (cached) return cached;
  const sections: Record<string, z.AnyZodObject> = {};
  for (const [name, schema] of Object.entries(area.sections)) {
    sections[name] = schema.strict().partial();
  }
  const built = z.object(sections).strict().partial();
  patchSchemas.set(area.key, built);
  return built;
}

function asAreaValue(candidate: unknown, key: string): AreaValue {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(`${key}: a settings value must be an object of sections`);
  }
  const value: Record<string, Record<string, unknown>> = {};
  for (const [name, section] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`${key}: section ${name} must be an object`);
    }
    value[name] = { ...(section as Record<string, unknown>) };
  }
  return value;
}

const defaultValues = new Map<string, AreaValue>();

/** The typed defaults, parsed once so a missing document reads as a valid payload. */
export function defaultsOf(area: AreaDefinition): AreaValue {
  const cached = defaultValues.get(area.key);
  if (cached) return cached;
  const parsed = fullSchemaOf(area).safeParse(area.defaults);
  if (!parsed.success) {
    throw new Error(
      `Area ${area.key} has defaults that do not satisfy its own schema: ${parsed.error.message}`,
    );
  }
  const value = asAreaValue(parsed.data, area.key);
  defaultValues.set(area.key, value);
  return value;
}

export { asAreaValue };

/**
 * Parsed at import, so a default that does not satisfy its own schema stops the
 * process at boot rather than at the first request that reads that area.
 */
for (const area of ALL_AREAS) defaultsOf(area);
