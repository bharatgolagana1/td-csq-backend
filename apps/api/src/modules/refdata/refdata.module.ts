import { z } from 'zod';
import { defineModule } from '../../kernel/router.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import {
  AirportBulkUpload,
  AirportInput,
  AirportPatch,
  AirportQuery,
  BankCodeParam,
  BankVersionInput,
  BankVersionParam,
  CategoryInput,
  CategoryParam,
  CategoryPatch,
  IataParam,
  MarketShareInput,
  ProfileIdParam,
  QuestionBankInput,
  ReplaceOperatorRoster,
  ScopeQuery,
  SnapshotParam,
  WeightTable,
  WeightingProfileInput,
} from './refdata.contracts.js';
import {
  PLATFORM_READ,
  PLATFORM_READ_REASON,
  PLATFORM_WRITE,
  PLATFORM_WRITE_REASON,
  platform,
} from './refdata.platform.js';
import {
  bulkUpsertAirports,
  createAirport,
  getAirport,
  getAirportForPlatform,
  listAirports,
  patchAirport,
  replaceOperatorRoster,
} from './airports.service.js';
import { createCategory, listCategories, patchCategory } from './categories.service.js';
import {
  createBank,
  createVersion,
  listBanks,
  listVersions,
  publishVersion,
  readPublishedInstrument,
  readSnapshot,
} from './questionBank.service.js';
import {
  createProfile,
  listPublishedProfiles,
  publishProfile,
  putWeights,
  readProfileForPlatform,
  readPublishedProfile,
  validateProfile,
} from './weighting.service.js';
import { currentMarketShare, marketShareHistory, recordMarketShare } from './marketShare.service.js';

export const REFDATA_READ = 'refdata:read';

/**
 * Reference data: the airports, the four assessment heads, the ACFI instrument
 * and the weights it is scored with. Reading is open to any member of any
 * organisation that holds refdata:read, because a standard everybody is scored
 * against has to be a standard everybody can read. Writing is platform work.
 *
 * Market share is the exception on both counts. It is written by an airport
 * administrator and read by nobody else, because how an airport's traffic
 * divides between two competing terminal operators is ACFI's commercial
 * information rather than either operator's. The operator roster is withheld
 * from the organisation facing view for the same reason.
 *
 * The staff routes are declared SELF with a written openReason rather than
 * PLATFORM, and assert their capability inside the handler. See the note at the
 * top of refdata.platform.ts for why, and for why refdata in particular loses
 * nothing by not entering a system scope.
 */

const ListQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const refdataModule = defineModule({
  name: 'refdata',
  basePath: '/v1/refdata',
  // the two platform capabilities are declared here as the module's own, and
  // enforced by platform() rather than by the kernel guard
  capabilities: [REFDATA_READ, PLATFORM_READ, PLATFORM_WRITE],
  routes: [
    {
      method: 'get',
      path: '/categories',
      summary: 'The assessment heads',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) => listCategories(parseQuery(ListQuery, req).includeInactive),
    },
    {
      method: 'post',
      path: '/categories',
      summary: 'Add an assessment head',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => createCategory(parseBody(CategoryInput, req))),
    },
    {
      method: 'patch',
      path: '/categories/:code',
      summary: 'Rename or reorder an assessment head',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) =>
        patchCategory(parseParams(CategoryParam, req).code, parseBody(CategoryPatch, req)),
      ),
    },

    {
      method: 'get',
      path: '/airports',
      summary: 'Search the airport reference table',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) => listAirports(parseQuery(AirportQuery, req)),
    },
    {
      method: 'post',
      path: '/airports',
      summary: 'Add an airport',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => createAirport(parseBody(AirportInput, req))),
    },
    {
      method: 'post',
      path: '/airports/bulk',
      summary: 'Bulk upload airports, all or nothing',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => {
        const { rows, dryRun } = parseBody(AirportBulkUpload, req);
        return bulkUpsertAirports(rows, { dryRun });
      }),
    },
    {
      method: 'get',
      path: '/airports/:iataCode',
      summary: 'One airport',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) => getAirport(parseParams(IataParam, req).iataCode),
    },
    {
      method: 'patch',
      path: '/airports/:iataCode',
      summary: 'Correct an airport',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) =>
        patchAirport(parseParams(IataParam, req).iataCode, parseBody(AirportPatch, req)),
      ),
    },
    {
      method: 'get',
      path: '/airports/:iataCode/operators',
      summary: 'Who operates at an airport and which of them subscribe',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_READ_REASON },
      handler: platform(PLATFORM_READ, (req) => getAirportForPlatform(parseParams(IataParam, req).iataCode)),
    },
    {
      method: 'put',
      path: '/airports/:iataCode/operators',
      summary: 'Replace an airport operator roster',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) =>
        replaceOperatorRoster(
          parseParams(IataParam, req).iataCode,
          parseBody(ReplaceOperatorRoster, req).operators,
        ),
      ),
    },

    {
      method: 'get',
      path: '/question-banks',
      summary: 'Question banks and which version of each is live',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: () => listBanks(),
    },
    {
      method: 'post',
      path: '/question-banks',
      summary: 'Create a question bank',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => createBank(parseBody(QuestionBankInput, req))),
    },
    {
      method: 'get',
      path: '/question-banks/:code/versions',
      summary: 'Every version of a question bank',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) => listVersions(parseParams(BankCodeParam, req).code),
    },
    {
      method: 'post',
      path: '/question-banks/:code/versions',
      summary: 'Open a draft version of a question bank',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => {
        const { questions, notes } = parseBody(BankVersionInput, req);
        return createVersion(parseParams(BankCodeParam, req).code, { questions, notes });
      }),
    },
    {
      method: 'post',
      path: '/question-banks/:code/versions/:version/publish',
      summary: 'Freeze a draft into a content addressed snapshot',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req, actor) => {
        const { code, version } = parseParams(BankVersionParam, req);
        return publishVersion(code, version, actor.userId);
      }),
    },
    {
      method: 'get',
      path: '/question-banks/:code/published',
      summary: 'The live instrument as one form asks it',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) =>
        readPublishedInstrument(parseParams(BankCodeParam, req).code, parseQuery(ScopeQuery, req).scope),
    },
    {
      method: 'get',
      path: '/snapshots/:contentHash',
      summary: 'An instrument by its content hash, verified on the way out',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: async (req) => {
        const snapshot = await readSnapshot(parseParams(SnapshotParam, req).contentHash);
        return { snapshotId: snapshot.id, firstVersion: snapshot.firstVersion, ...snapshot.content };
      },
    },

    {
      method: 'get',
      path: '/weighting-profiles',
      summary: 'Published weighting profiles',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: () => listPublishedProfiles(),
    },
    {
      method: 'post',
      path: '/weighting-profiles',
      summary: 'Open a draft weighting profile against one instrument',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) => createProfile(parseBody(WeightingProfileInput, req))),
    },
    {
      method: 'get',
      path: '/weighting-profiles/:profileId',
      summary: 'One published weighting profile',
      policy: { requiredCapability: REFDATA_READ, tenancy: 'ORG' },
      handler: (req) => readPublishedProfile(parseParams(ProfileIdParam, req).profileId),
    },
    {
      method: 'put',
      path: '/weighting-profiles/:profileId/weights',
      summary: 'Replace the weights of a draft profile',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req) =>
        putWeights(parseParams(ProfileIdParam, req).profileId, parseBody(WeightTable, req)),
      ),
    },
    {
      method: 'get',
      path: '/weighting-profiles/:profileId/validation',
      summary: 'What the publish gate would say about a draft',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_READ_REASON },
      handler: platform(PLATFORM_READ, async (req) => {
        const { profileId } = parseParams(ProfileIdParam, req);
        const [profile, validation] = await Promise.all([
          readProfileForPlatform(profileId),
          validateProfile(profileId),
        ]);
        return { ...validation, code: profile.code, version: profile.version, state: profile.state };
      }),
    },
    {
      method: 'post',
      path: '/weighting-profiles/:profileId/publish',
      summary: 'Publish a weighting profile once its weights add up',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req, actor) =>
        publishProfile(parseParams(ProfileIdParam, req).profileId, actor.userId),
      ),
    },

    {
      method: 'get',
      path: '/airports/:iataCode/market-share',
      summary: 'The market share standing at an airport',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_READ_REASON },
      handler: platform(PLATFORM_READ, (req) => currentMarketShare(parseParams(IataParam, req).iataCode)),
    },
    {
      method: 'get',
      path: '/airports/:iataCode/market-share/history',
      summary: 'Every market share ever recorded at an airport',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_READ_REASON },
      handler: platform(PLATFORM_READ, (req) =>
        marketShareHistory(parseParams(IataParam, req).iataCode, parseQuery(HistoryQuery, req).limit),
      ),
    },
    {
      method: 'post',
      path: '/airports/:iataCode/market-share',
      summary: 'Record a new market share, superseding the standing one',
      status: 201,
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_WRITE_REASON },
      handler: platform(PLATFORM_WRITE, (req, actor) =>
        recordMarketShare(parseParams(IataParam, req).iataCode, parseBody(MarketShareInput, req), actor.userId),
      ),
    },
  ],
});
