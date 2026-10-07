// `npm run seed [-- --super-admin email=<e-mail> name=<name>]`
import { loadEnv } from '../config/env.js';
import { connectDb, disconnectDb } from '../core/db.js';
import { initLogger } from '../core/logger.js';

import { seedCore } from './core.js';
import { describeSuperAdmin, ensureSuperAdmin } from './super-admin.js';
import { describeSeededSurvey, seedSurveys } from './surveys.js';

interface Args {
  superAdmin: { email: string; name: string } | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { superAdmin: null };
  const index = argv.indexOf('--super-admin');
  if (index === -1) return args;
  const pairs = new Map<string, string>();
  for (const token of argv.slice(index + 1)) {
    if (token.startsWith('--')) break;
    const [key, ...rest] = token.split('=');
    if (key && rest.length > 0) pairs.set(key, rest.join('='));
  }
  const email = pairs.get('email');
  const name = pairs.get('name');
  if (!email || !name) {
    console.error('Usage: npm run seed -- --super-admin email=<e-mail> name=<name>');
    process.exit(2);
  }
  args.superAdmin = { email, name };
  return args;
}

const env = loadEnv();
initLogger({ level: 'warn', pretty: env.NODE_ENV === 'development' });
const args = parseArgs(process.argv.slice(2));

await connectDb(env.MONGO_URI);
try {
  const result = await seedCore();
  console.log(`Seeded ${result.tasks} tasks, ${result.roles} roles, ${result.grants} default grants, settings, ACFI organisation.`);
  if (result.airports) {
    console.log(`Airports: ${result.airports.rows} in the vendored list, ${result.airports.inserted} inserted.`);
  }
  const surveys = await seedSurveys();
  console.log(`Surveys: ${describeSeededSurvey('DOMESTIC', surveys.DOMESTIC)}; ${describeSeededSurvey('INTERNATIONAL', surveys.INTERNATIONAL)}.`);
  if (args.superAdmin) {
    const { user, created } = await ensureSuperAdmin(args.superAdmin);
    console.log(`${created ? 'Created' : 'Kept'} super admin ${describeSuperAdmin(user)}.`);
    if (user.keycloakSub === null) {
      console.log('Create this e-mail in Keycloak; the first sign-in links and activates the account.');
    }
  }
} finally {
  await disconnectDb();
}
