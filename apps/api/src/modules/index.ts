import type { ApiModule } from '../kernel/router.js';

import { orgsModule } from './orgs/orgs.module.js';
import { refdataModule } from './refdata/refdata.module.js';
import { cyclesModule } from './cycles/cycles.module.js';
import { samplingModule } from './sampling/sampling.module.js';
import { assessmentsModule } from './assessments/assessments.module.js';
import { scoringModule, dashboardModule } from './scoring/scoring.module.js';
import { settingsModule } from './settings/settings.module.js';

/**
 * Mount order follows the dependency direction of the domain:
 * reference data and organisations exist before a cycle can name them, a cycle
 * exists before a sample can be locked against it, and scoring reads what the
 * assessments produced.
 */
export const MODULES: readonly ApiModule[] = [
  orgsModule,
  refdataModule,
  cyclesModule,
  samplingModule,
  assessmentsModule,
  scoringModule,
  dashboardModule,
  settingsModule,
];
