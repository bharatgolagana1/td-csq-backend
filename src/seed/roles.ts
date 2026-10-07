import type { SeedRole } from '../modules/identity/roles.service.js';

/** ARCHITECTURE §4 seeded roles. Administrators may add more through POST /roles. */
export const SEED_ROLES: readonly SeedRole[] = [
  { code: 'SUPER_ADMIN', name: 'Super Admin', description: 'ACFI platform administrator; every task', scope: 'PLATFORM' },
  { code: 'ACFI_ANALYST', name: 'ACFI Analyst', description: 'Read-only platform analyst: views, reports and monitoring', scope: 'PLATFORM' },
  { code: 'ACO_ADMIN', name: 'Operator Admin', description: 'Runs an operator: customers, sampling and lock, self-assessment, users', scope: 'ACO' },
  { code: 'ACO_USER', name: 'Operator User', description: 'Works inside an operator: customers, sampling, self-assessment, reports', scope: 'ACO' },
  { code: 'AIRPORT_ADMIN', name: 'Airport Admin', description: 'Airport reports and the airport organisation\'s users', scope: 'AIRPORT' },
  { code: 'AIRPORT_VIEWER', name: 'Airport Viewer', description: 'Airport reports only', scope: 'AIRPORT' },
];
