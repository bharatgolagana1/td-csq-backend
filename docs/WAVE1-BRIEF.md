# Wave 1 brief — feature modules

Read `docs/ARCHITECTURE.md` (binding) and `docs/REQUIREMENTS.md` first. This
brief adds what the architecture leaves to the builder: who owns which
folders, how features talk to each other, and what "done" means. Several
agents work concurrently on disjoint folders; never edit outside your
ownership, never commit.

## 0. What already exists (Wave 0)

- `src/core/**` — env, logger, errors, `route()` helper, db + `withTransaction`,
  auth (keycloak verifier, session → `req.ctx`, `requireTask`, link sessions),
  pagination, ids, scheduler (`registerJob`, `once`).
- `src/modules/identity`, `organisations` (operators + market share),
  `airports`, `settings`, `audit` (`audit(ctx, …)`), `notifications`
  (`send({ template, to, vars, refs })`, templates registry), `health`.
- Pure domain rules, already tested, to be USED not re-implemented:
  `src/modules/scoring/engine/**` (roll-up, distribution, ranking, airport,
  comparison), `src/modules/cycles/domain/**` (windows, derive, transitions,
  participants), `src/modules/sampling/domain/**` (eligibility, lockGate,
  selection), `src/modules/customers/domain/**` (CSV template/validate),
  `src/modules/invitations/domain/**` (token, otpPolicy, states).
- Survey data: `src/modules/surveys/data/acfi-csq-phase1.yaml` (27 parameters,
  four heads; `scopes` says which survey type a question belongs to) and
  `heads.yaml`.
- Test harness: `test/helpers/app.ts` → `createTestApp()`, `asUser({ orgType,
  roleCode, email })`; tests run against the local replica set (`csq_test`).

Read the foundation's README and one existing module (e.g. `organisations`)
before writing yours; match its file naming, `route()` usage, schema style,
and test style exactly.

## 1. Ownership

| Agent | Owns | Also owns |
|---|---|---|
| onboarding | `src/modules/onboarding/**`, `test/onboarding*` | templates `registration-received`, `registration-approved`, `registration-rejected` under `src/modules/notifications/templates/` (new files only) |
| surveys | `src/modules/surveys/**` (not `data/` contents), `test/surveys*` | `seed/surveys.ts` (called by `npm run seed`) |
| cycles | `src/modules/cycles/**` (not `domain/`), `src/jobs/cycles.*`, `test/cycles*` | **`src/core/events.ts`** (see §2), templates `cycle-published`, `sampling-reminder`, `sampling-closed` |
| customers | `src/modules/customers/**` (not `domain/`), `test/customers*` | registers `countCustomers` into organisations |
| sampling | `src/modules/sampling/**` (not `domain/`), `test/sampling*` | templates `sample-locked`, `sample-unlocked` |
| invitations | `src/modules/invitations/**` (not `domain/`), `src/jobs/invitations.*`, `test/invitations*` | templates `assessment-invitation`, `assessment-otp`, `assessment-reminder`, `assessment-thank-you` |
| assessments | `src/modules/assessments/**`, `test/assessments*` | — |
| scoring | `src/modules/scoring/**` (not `engine/`), `src/jobs/scoring.*`, `test/scoring*` (not `test/unit/scoring`) | — |
| reports | `src/modules/reports/**`, `test/reports*` | `seed/demo.ts` (`npm run seed:demo`) |

`src/modules/index.ts`: each agent adds ONE line registering its module.
Keep the list in the dependency order of §2 of ARCHITECTURE.md. If two agents
touch the file, the later one keeps both lines.

## 2. How features talk (binding)

Dependency direction (lower never imports higher):
`identity, organisations, airports, settings, audit, notifications` →
`surveys` → `cycles` → `customers` → `sampling` → `invitations` →
`assessments` → `scoring` → `reports` → `onboarding` (onboarding only uses
organisations, identity, notifications).

A higher feature calls a lower one through its exported service functions
(`import { getCycle } from '../cycles/cycles.service.js'`). A lower feature
never imports a higher one; when it must trigger work above it, it emits an
event.

### `src/core/events.ts` and `src/core/auth/system.ts` (exist; read them)

`on(event, 'module.handlerName', handler)` / `emit(event, payload, { ctx,
session? })`. The `Events` map lists every event and payload. `emit` awaits
every handler in registration order and fails the emitting operation on a
handler error (no fire-and-forget); when the emitter holds a transaction it
passes `session`, and handlers must write through it. Register handlers in
your module's `index.ts` via the `registerHandlers` field of
`defineModule({...})` — the registry calls it once per process when the API
router is built (server and test apps alike). Jobs and handlers run under
`systemContext(reason)` from `core/auth/system.ts`; services that can be
called from both paths accept `AnyContext` and use `requestContextOf(ctx)`
when they audit. Tests that register handlers twice should call
`clearEventHandlers()` in `beforeEach` only if they build modules by hand;
`createTestApp()` goes through the registry, which already guards.

### Who listens to what

| Event | Listener | Does |
|---|---|---|
| `cycle.published` | invitations | nothing yet (reserved) |
| `cycle.transitioned` to `SAMPLING_OPEN` | cycles itself | e-mails ACO admins |
| `cycle.transitioned` to `ASSESSMENT_OPEN` | invitations | `activateCycle(cycleId)`: tokens + e-mails for PENDING invitations of LOCKED participants |
| `cycle.transitioned` to `ASSESSMENT_CLOSED` | scoring | `runCycle(cycleId, { provisional: false })` then cycles marks SCORED on `scoring.completed` |
| `sample.locked` | invitations | create PENDING invitations (idempotent on cycle+aco+customer+surveyType) |
| `sample.unlocked` | invitations | revoke PENDING invitations of that participant |
| `assessment.submitted` | invitations (CUSTOMER) | invitation → SUBMITTED, thank-you e-mail |
| `assessment.submitted` | cycles | participant `stats.completed` / `selfAssessment` status |
| `invitation.sent` | cycles | participant `stats.invited` |
| `scoring.completed` | cycles | status SCORED when not provisional |

### Exported service functions each module must provide (names are binding)

- **surveys**: `getPublishedSurvey(type)`, `getSurveyTree(surveyId)`,
  `getFormForStakeholder(surveyId, stakeholderType)` (active questions only,
  ordered), `latestPublishedVersionIds()` → `{ DOMESTIC?, INTERNATIONAL? }`.
- **cycles**: `getCycle(ctx, id)`, `getParticipant(cycleId, acoId)`,
  `listParticipants(cycleId)`, `setParticipantSampling(cycleId, acoId, patch)`,
  `bumpParticipantStats(cycleId, acoId, field, delta)`,
  `currentCyclesForOperator(acoId)`, `isMarketShareFrozen(cycleId)` (registered
  into organisations at boot), `transition(ctx, cycleId, to, reason)`.
- **customers**: `getCustomer(acoId, id)`, `listEligible(acoId, cycleType)`,
  `countByAco(acoId)` (registered into organisations), `emailsByAco(acoId)`.
- **sampling**: `getSelection(cycleId, acoId)`, `lock(ctx, cycleId)`,
  `unlock(ctx, cycleId, acoId, reason)`.
- **invitations**: `createPendingForSamples(payload)`, `activateCycle(cycleId)`,
  `revokePending(cycleId, acoId)`, `sendReminders(cycleId, now)`,
  `getByToken(token)`, `markSubmitted(invitationId)`.
- **assessments**: `getOrCreateForInvitation(invitation)`,
  `getForm(assessmentId)`, `getDraft(assessmentId)`,
  `patchAnswers(assessmentId, answers)`, `readiness(assessmentId)`,
  `submit(ctx|link, assessmentId)`, `getOrCreateSelf(ctx, cycleId, surveyType)`,
  `listSubmitted(cycleId, acoId, kind?)`.
- **scoring**: `runCycle(cycleId, { provisional })`, `getScores(cycleId, acoId,
  surveyType)`, `getAirportScores(cycleId, airportId)`, `nationalTable(cycleId,
  surveyType)`.
- **reports**: read-only composition over the above.

## 3. Jobs (scheduler)

`src/jobs/<feature>.jobs.ts` registers runners with `registerJob(name, fn)`:
- cycles: `cycles.transitions` (every minute: `dueTransitions` per non-terminal
  cycle → `transition(systemCtx, …, 'CLOCK')`), `cycles.samplingReminders`.
- invitations: `invitations.activate` (safety net: PENDING invitations of a
  cycle already ASSESSMENT_OPEN), `invitations.reminders`, `invitations.expire`.
- scoring: `scoring.nightly` (provisional run for every ASSESSMENT_OPEN cycle at
  01:00 local).
Use `once(type, refId, slot, fn)` so a tick never repeats work.

## 4. Done means

- Routes exactly as ARCHITECTURE §6 for your module, every one with a policy.
- Services take `ctx` + typed input; scope enforced; cross-tenant → 404.
- Audit entries for every action listed in ARCHITECTURE §7 that your module performs.
- Tests: service level + route level + the module's part of the flow
  (`test/<feature>.flow.test.ts` may drive lower modules' services directly).
- `npm run typecheck && npm run lint && npm test` green with everyone's
  modules present (run the full suite before reporting; fix only your files
  and report anything that fails elsewhere).
- README: one short section per module (routes, events, jobs).
