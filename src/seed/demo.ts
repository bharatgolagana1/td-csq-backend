// `npm run seed:demo [-- --super-admin email=<e-mail> name=<name>] [--reset]`
//
// Builds the illustrative ACFI dataset on top of `npm run seed` (see
// src/seed/demo/run.ts). Re-running keeps what exists; `--reset` removes
// every document tagged `demo: true` / `demoKey` first and rebuilds.
import { loadEnv } from '../config/env.js';
import { connectDb, disconnectDb } from '../core/db.js';
import { initLogger } from '../core/logger.js';

import { runDemoSeed, type DemoSeedOptions } from './demo/run.js';

function parseArgs(argv: string[]): DemoSeedOptions {
  const options: DemoSeedOptions = { reset: argv.includes('--reset') };
  const index = argv.indexOf('--super-admin');
  if (index === -1) return options;
  const pairs = new Map<string, string>();
  for (const token of argv.slice(index + 1)) {
    if (token.startsWith('--')) break;
    const [key, ...rest] = token.split('=');
    if (key && rest.length > 0) pairs.set(key, rest.join('='));
  }
  const email = pairs.get('email');
  const name = pairs.get('name');
  if (!email || !name) {
    console.error('Usage: npm run seed:demo -- [--super-admin email=<e-mail> name=<name>] [--reset]');
    process.exit(2);
  }
  options.superAdmin = { email, name };
  return options;
}

const env = loadEnv();
initLogger({ level: 'warn', pretty: env.NODE_ENV === 'development' });
const options = parseArgs(process.argv.slice(2));

await connectDb(env.MONGO_URI);
try {
  const result = await runDemoSeed({ ...options, log: (line) => console.log(line) });
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log('');
  console.log(`Demo dataset ready in ${seconds} s (acting as ${result.actor.name} <${result.actor.email}>).`);
  console.log(`Operators: ${result.operators.map((operator) => `${operator.code}@${operator.iata}`).join(', ')}`);
  for (const cycle of result.cycles) console.log(`Cycle ${cycle.code}: ${cycle.status}${cycle.fresh ? ' (built)' : ' (kept)'} — ${cycle.id}`);
  if (result.onboarding.unusedLinkUrl) console.log(`Open onboarding link (shown once): ${result.onboarding.unusedLinkUrl}`);
  const interesting = ['organisations', 'users', 'customers', 'cycles', 'samples', 'invitations', 'assessments', 'scores', 'airport_scores', 'registrations', 'notifications', 'audit_log'];
  console.log(`Tagged documents: ${interesting.map((name) => `${name} ${result.counts[name] ?? 0}`).join(' · ')}`);
  console.log('Every figure is illustrative; names and addresses are fictional. E-mails went to the notifications log only.');
} finally {
  await disconnectDb();
}
