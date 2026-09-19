import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { createDatabase } from '../../db/connect.js';
import { createLogger } from '../../kernel/logger.js';
import { runSystem } from '../../kernel/requestContext.js';
import { newId } from '../../kernel/ids.js';
import {
  MembershipModel,
  OrganizationModel,
  RoleDefinitionModel,
  type OrganizationDoc,
} from './orgs.models.js';
import { projectMembership } from './orgs.access.js';
import { createMembershipForOrg } from './orgs.members.js';
import { findOrCreateUser } from './orgs.users.js';
import {
  CountryCode,
  Email,
  OrgCode,
  RoleCatalogue,
  type RoleDefinitionData,
} from './orgs.contracts.js';

/**
 * Seeds the role catalogue and, when asked, the first organisation that can
 * approve everybody else.
 *
 *   node dist/modules/orgs/orgs.seed.js --roles-only
 *   node dist/modules/orgs/orgs.seed.js \
 *     --platform-code ACFI --platform-name "Air Cargo Forum India" \
 *     --platform-city Mumbai --platform-state Maharashtra \
 *     --platform-country IN --platform-region West \
 *     --admin-email ops@example.org --admin-given-name Asha --admin-family-name Rao \
 *     [--admin-kc-user-id 1f0c...]
 *
 * The role catalogue is data in data/role-classes.json, not literals in a
 * handler, so
 * changing who may do what is a seed run and a diff rather than a deploy of new
 * code. The bootstrap values are arguments rather than defaults because a
 * default organisation is exactly the kind of thing that survives into
 * production and nobody notices until it is quoted in a report.
 */

const CATALOGUE = join(__dirname, 'data', 'role-classes.json');

export function loadRoleCatalogue(): RoleDefinitionData[] {
  // parsed rather than trusted: the file is edited by hand, and a capability
  // with a typo in it is a permission nobody can ever be granted
  const result = RoleCatalogue.safeParse(JSON.parse(readFileSync(CATALOGUE, 'utf8')) as unknown);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${CATALOGUE} is not a valid role catalogue:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

export async function seedRoleDefinitions(
  rows: readonly RoleDefinitionData[],
): Promise<{ written: number; removed: number }> {
  for (const row of rows) {
    await RoleDefinitionModel.updateOne(
      { _id: row.code },
      {
        $set: {
          label: row.label,
          description: row.description,
          orgTypes: row.orgTypes,
          capabilities: row.capabilities,
          grantedOnApproval: row.grantedOnApproval,
        },
      },
      { upsert: true },
    ).exec();
  }

  // a role class removed from the catalogue is removed from the database, or a
  // membership could keep granting something the product no longer defines
  const removal = await RoleDefinitionModel.deleteMany({
    _id: { $nin: rows.map((row) => row.code) },
  }).exec();

  return { written: rows.length, removed: removal.deletedCount };
}

export const BootstrapArgs = z.object({
  platformCode: OrgCode,
  platformName: z.string().trim().min(2).max(200),
  platformCity: z.string().trim().min(1).max(80),
  platformState: z.string().trim().min(1).max(80),
  platformCountry: CountryCode,
  platformRegion: z.string().trim().min(1).max(80),
  adminEmail: Email,
  adminGivenName: z.string().trim().min(1).max(80),
  adminFamilyName: z.string().trim().min(1).max(80),
  adminKcUserId: z.string().trim().min(8).max(128).optional(),
});
export type BootstrapArgs = z.infer<typeof BootstrapArgs>;

/**
 * The platform organisation is born ACTIVE. Every other organisation reaches
 * ACTIVE by being approved, and the thing that approves them cannot approve
 * itself into existence.
 */
async function ensurePlatformOrganization(args: BootstrapArgs): Promise<OrganizationDoc> {
  const existing = await OrganizationModel.findOne({ code: args.platformCode }).lean().exec();
  if (existing) {
    if (existing.type !== 'PLATFORM') {
      throw new Error(`${args.platformCode} already exists and is a ${existing.type}, not the platform`);
    }
    return existing;
  }

  const created = await OrganizationModel.create({
    _id: newId(),
    type: 'PLATFORM',
    state: 'ACTIVE',
    legalName: args.platformName,
    legalNameLower: args.platformName.toLowerCase(),
    displayName: null,
    code: args.platformCode,
    airportId: null,
    address: {
      city: args.platformCity,
      state: args.platformState,
      country: args.platformCountry,
      region: args.platformRegion,
    },
    registrationIds: { cin: null, gstin: null, pan: null },
    formScope: null,
    samplingApprovalMode: 'SUPER_ADMIN',
    primaryContact: null,
    submittedAt: null,
    approvedAt: new Date(),
    approvedBy: null,
    stateHistory: [],
  });
  return created.toObject();
}

export async function bootstrapPlatform(args: BootstrapArgs): Promise<{
  organizationId: string;
  userId: string;
  roleClass: string;
  created: boolean;
}> {
  const org = await ensurePlatformOrganization(args);

  const role = await RoleDefinitionModel.findOne({ grantedOnApproval: true, orgTypes: 'PLATFORM' })
    .select('_id')
    .lean()
    .exec();
  if (!role) throw new Error('No role class is granted on approval for a PLATFORM. Seed the catalogue first.');

  const user = await findOrCreateUser({
    email: args.adminEmail,
    givenName: args.adminGivenName,
    familyName: args.adminFamilyName,
    kind: 'STAFF',
    phoneE164: null,
    whatsappOptIn: false,
    ...(args.adminKcUserId ? { kcUserId: args.adminKcUserId } : {}),
  });

  const existing = await MembershipModel.findOne({ orgId: org._id, userId: user._id, isActive: true })
    .lean()
    .exec();
  const membership =
    existing ?? (await createMembershipForOrg(org._id, { userId: user._id, roleClasses: [role._id], invitedBy: null }));

  await projectMembership(membership, org);
  return { organizationId: org._id, userId: user._id, roleClass: role._id, created: existing === null };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function readBootstrapArgs(argv: readonly string[]): BootstrapArgs | null {
  if (argv.includes('--roles-only')) return null;

  const candidate = {
    platformCode: flag(argv, 'platform-code'),
    platformName: flag(argv, 'platform-name'),
    platformCity: flag(argv, 'platform-city'),
    platformState: flag(argv, 'platform-state'),
    platformCountry: flag(argv, 'platform-country'),
    platformRegion: flag(argv, 'platform-region'),
    adminEmail: flag(argv, 'admin-email'),
    adminGivenName: flag(argv, 'admin-given-name'),
    adminFamilyName: flag(argv, 'admin-family-name'),
    adminKcUserId: flag(argv, 'admin-kc-user-id'),
  };

  const result = BootstrapArgs.safeParse(candidate);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `--${String(i.path[0])}: ${i.message}`);
    throw new Error(
      `The bootstrap needs every value spelled out. Pass --roles-only to seed the catalogue alone.\n  ${problems.join('\n  ')}`,
    );
  }
  return result.data;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, false);
  const bootstrap = readBootstrapArgs(process.argv.slice(2));

  const db = createDatabase({ uri: env.MONGO_URI, log, maxPoolSize: 5, minPoolSize: 1 });
  await db.connect();
  try {
    const catalogue = await seedRoleDefinitions(loadRoleCatalogue());
    log.info(catalogue, 'role catalogue seeded');

    if (bootstrap) {
      const result = await runSystem(
        { reason: 'orgs seed: bootstrapping the platform organisation', log },
        () => bootstrapPlatform(bootstrap),
      );
      log.info(result, 'platform bootstrapped');
    }
  } finally {
    await db.disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
