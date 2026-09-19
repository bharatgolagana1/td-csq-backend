import { z } from 'zod';
import { FormScope, Ulid } from '@csq/contracts';

/**
 * Reference data is the one part of CSQ that is the same for every
 * organisation: the airports, the ACFI instrument, the weights it is scored
 * with. It is therefore global rather than tenant scoped, and it is written by
 * ACFI staff rather than by an operator.
 *
 * Everything inbound is parsed here. Nothing is coerced on the way in: a bulk
 * upload with a lower-case IATA code is refused rather than silently upper
 * cased, because a file that needed repairing is a file whose other columns
 * have not been checked either.
 */

export const IataCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be three upper case letters, e.g. BOM');
export const IcaoCode = z
  .string()
  .regex(/^[A-Z]{4}$/, 'must be four upper case letters, e.g. VABB');
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code, e.g. IN');
/** ISO 3166-2 subdivision, which is what the region dashboards group by. */
export const RegionCode = z
  .string()
  .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'must be an ISO 3166-2 subdivision code, e.g. IN-MH');

/**
 * A zone this runtime can actually resolve, not merely one that looks like a
 * zone. A cycle boundary typed as "midnight on the 12th" is meaningless if the
 * airport's zone is a string nobody can convert.
 */
function isResolvableTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const IanaTimezone = z
  .string()
  .min(3)
  .max(64)
  .refine(isResolvableTimezone, 'must be an IANA time zone this runtime can resolve, e.g. Asia/Kolkata');

export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);

/** An operator on an airport's roster. Subscribed operators are the ones CSQ scores. */
export const OperatorRosterEntry = z
  .object({
    /** Stable handle for the operator at this airport, independent of its display name. */
    operatorKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'must be an upper case key, e.g. AISATS'),
    name: z.string().min(2).max(160),
    /** The CSQ organisation, once the operator has one. Null until it registers. */
    orgId: Ulid.nullable().default(null),
    subscribed: z.boolean(),
  })
  .strict()
  .refine(
    (entry) => !entry.subscribed || entry.orgId !== null,
    'a subscribed operator needs an organisation, because market share lines are keyed by it',
  );
export type OperatorRosterEntry = z.infer<typeof OperatorRosterEntry>;

export const ReplaceOperatorRoster = z
  .object({ operators: z.array(OperatorRosterEntry).max(32) })
  .strict();

export const AirportInput = z
  .object({
    iataCode: IataCode,
    icaoCode: IcaoCode.nullable().default(null),
    name: z.string().min(2).max(160),
    /** Three of the 116 seeded Indian airports have no municipality upstream. */
    city: z.string().min(1).max(120).nullable().default(null),
    country: CountryCode,
    region: RegionCode,
    latitude: Latitude,
    longitude: Longitude,
    timezone: IanaTimezone,
    isActive: z.boolean().default(true),
  })
  .strict();
export type AirportInput = z.infer<typeof AirportInput>;

export const AirportPatch = AirportInput.omit({ iataCode: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to change');

/**
 * A bulk upload is all or nothing. Partially applying a file leaves the
 * administrator guessing which half landed, and the half that landed is the
 * half nobody validated against the rows that failed.
 */
export const AirportBulkUpload = z
  .object({
    rows: z.array(AirportInput).min(1).max(1000),
    /** Validate and report without writing, which is how a file gets fixed. */
    dryRun: z.boolean().default(false),
  })
  .strict();

export const AirportQuery = z
  .object({
    q: z.string().min(1).max(80).optional(),
    country: CountryCode.optional(),
    region: RegionCode.optional(),
    includeInactive: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const IataParam = z.object({ iataCode: IataCode });

export const CategoryCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,23}$/, 'must be an upper case code, e.g. INFRA');

export const CategoryInput = z
  .object({
    code: CategoryCode,
    name: z.string().min(2).max(80),
    description: z.string().min(1).max(400).nullable().default(null),
    displayOrder: z.number().int().min(0).max(999),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CategoryInput = z.infer<typeof CategoryInput>;

export const CategoryPatch = CategoryInput.omit({ code: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to change');

export const CategoryParam = z.object({ code: CategoryCode });

/**
 * Question codes are ordinal free. The international form numbers trade
 * facilitation as section 5 and the domestic form numbers it 4, so a code built
 * from the printed number would name two different parameters depending on
 * which sheet of paper it was read from. Printed numbering is kept as formRef,
 * which is display only.
 */
export const QuestionCode = z
  .string()
  .max(120)
  .regex(
    /^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]+)+$/,
    'must be dot separated segments each beginning with a letter, e.g. ACFI.INFRA.TC_BC_GENERATION. A numbered segment is refused because the printed forms number the same parameter differently',
  );

/** Mirrors QuestionSpec.answerType in @csq/core. Only RATING_5 may carry weight. */
export const AnswerType = z.enum(['RATING_5', 'TEXT', 'SINGLE_SELECT']);
export type AnswerType = z.infer<typeof AnswerType>;

/** A value that differs between the two printed forms, absent where it does not. */
const perScope = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ INTERNATIONAL: value.optional(), DOMESTIC: value.optional() }).strict();

export const ScopeText = perScope(z.string().min(10).max(1200));
export const ScopeRef = perScope(z.string().min(1).max(12));

export const QuestionOption = z
  .object({ key: z.string().min(1).max(60), label: z.string().min(1).max(200) })
  .strict();

export const BankQuestion = z
  .object({
    code: QuestionCode,
    categoryCode: CategoryCode,
    /** The wording both forms share. */
    text: z.string().min(10).max(1200),
    /** Wording for a scope whose printed form words the same parameter differently. */
    textByScope: ScopeText.default({}),
    /** Which printed form the parameter appears on. */
    scopes: z.array(FormScope).min(1),
    answerType: AnswerType,
    scored: z.boolean(),
    /** Printed numbering, per form. Display only, never an identifier. */
    formRef: ScopeRef,
    /** Sub-parameter tick boxes. They carry no weight; see DirectionalRating.options. */
    options: z.array(QuestionOption).max(32).default([]),
    helpText: z.string().min(1).max(600).nullable().default(null),
  })
  .strict()
  .superRefine((question, ctx) => {
    for (const scope of question.scopes) {
      if (question.formRef[scope] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['formRef', scope],
          message: `${question.code} claims the ${scope} form but carries no printed reference for it`,
        });
      }
    }
    for (const scope of Object.keys(question.textByScope) as Array<z.infer<typeof FormScope>>) {
      if (!question.scopes.includes(scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['textByScope', scope],
          message: `${question.code} carries ${scope} wording but does not appear on that form`,
        });
      }
    }
  });
export type BankQuestion = z.infer<typeof BankQuestion>;

export const BankCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,31}$/, 'must be an upper case code, e.g. ACFI_CSQ');

export const QuestionBankInput = z
  .object({
    code: BankCode,
    title: z.string().min(3).max(160),
    description: z.string().min(1).max(600).nullable().default(null),
    /** Where the questions came from, so a reviewer can check the wording. */
    sourceDocuments: z.array(z.string().min(3).max(200)).max(10).default([]),
  })
  .strict();
export type QuestionBankInput = z.infer<typeof QuestionBankInput>;

export const BankVersionInput = z
  .object({
    questions: z.array(BankQuestion).min(1).max(500),
    notes: z.string().min(1).max(600).nullable().default(null),
  })
  .strict();

/**
 * The frozen instrument. A snapshot embeds its categories rather than pointing
 * at the categories collection, because a snapshot that resolves anything at
 * read time is not frozen: renaming a category would rewrite the instrument a
 * submitted assessment was answered against.
 *
 * The version number is deliberately NOT part of it. The content is the
 * instrument; the version is the label the bank puts on it. Keeping the number
 * out means publishing v2 with nothing actually changed resolves to the same
 * snapshot, which is how an assessment answered under v1 is provably answering
 * the same questions as one answered under v2.
 */
export const SnapshotContent = z
  .object({
    bankCode: BankCode,
    bankTitle: z.string().min(3).max(160),
    categories: z
      .array(
        z
          .object({
            code: CategoryCode,
            name: z.string().min(2).max(80),
            displayOrder: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .min(1),
    questions: z.array(BankQuestion).min(1),
  })
  .strict();
export type SnapshotContent = z.infer<typeof SnapshotContent>;

export const ContentHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lower case sha-256 hex digest');

export const BankCodeParam = z.object({ code: BankCode });
export const BankVersionParam = z.object({ code: BankCode, version: z.coerce.number().int().min(1) });
export const SnapshotParam = z.object({ contentHash: ContentHash });
export const ScopeQuery = z.object({ scope: FormScope });

export const BP_TOTAL = 10_000;

const Bp = z.number().int().min(1).max(BP_TOTAL);

export const ScopeWeights = z
  .object({
    /** Category code to basis points. Must sum to 10000 across the scope. */
    categories: z.record(CategoryCode, Bp),
    /** Question code to basis points. Must sum to 10000 within each category. */
    questions: z.record(QuestionCode, Bp),
  })
  .strict();

export const WeightTable = z
  .object({ INTERNATIONAL: ScopeWeights, DOMESTIC: ScopeWeights })
  .strict();
export type WeightTable = z.infer<typeof WeightTable>;

export const WeightingProfileInput = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,47}$/, 'must be an upper case code'),
    title: z.string().min(3).max(160),
    /** EQUAL records that no differential weighting has been agreed, not that weights are absent. */
    basis: z.enum(['EQUAL', 'CONFIGURED']),
    /** The exact instrument these weights apply to. Weights without one cannot be checked. */
    snapshotId: ContentHash,
    notes: z.string().min(1).max(600).nullable().default(null),
  })
  .strict();

export const ProfileIdParam = z.object({ profileId: Ulid });

export const MARKET_SHARE_DERIVATIONS = ['SOLE_OPERATOR', 'SOLE_SUBSCRIBER', 'DISTRIBUTED'] as const;
export const MarketShareDerivation = z.enum(MARKET_SHARE_DERIVATIONS);
export type MarketShareDerivation = z.infer<typeof MarketShareDerivation>;

/**
 * Lines are optional because two of the three cases have only one possible
 * answer. The derivation itself is never accepted from the caller: it is read
 * off the airport's operator roster, so a submission cannot claim to be the
 * sole subscriber at an airport where three operators subscribe.
 */
export const MarketShareInput = z
  .object({
    lines: z
      .array(z.object({ orgId: Ulid, shareBp: Bp }).strict())
      .min(1)
      .max(32)
      .optional(),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    note: z.string().min(1).max(400).nullable().default(null),
  })
  .strict();
