// What scoring listens to (WAVE1-BRIEF §2 "Who listens to what"): the final
// run when the assessment closes. `transition` emits after its own write and
// without a session, so the run owns its transactions. A failing run
// surfaces as the transition's error while the cycle stays ASSESSMENT_CLOSED;
// the `scoring.finalise` job (src/jobs/scoring.jobs.ts) redoes it.
import { on, type EventMeta } from '../../core/events.js';

import { runCycle } from './scoring.service.js';

export function registerScoringHandlers(): void {
  on('cycle.transitioned', 'scoring.onAssessmentClosed', async (payload, meta: EventMeta) => {
    if (payload.to !== 'ASSESSMENT_CLOSED') return;
    await runCycle(payload.cycleId, { provisional: false, ctx: meta.ctx });
  });
}
