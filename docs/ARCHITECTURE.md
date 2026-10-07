# CSQ backend — architecture and API contract

This is the binding reference for everyone building the backend. The product
requirements are in `docs/REQUIREMENTS.md`; the demo storyline in
`docs/DEMO-PLAN.md`. The frontend repo builds against the API contract in
section 6 of this file — change the contract here first, then the code.

## 1. Stack

- Node ≥ 22 (26 on the dev machine), TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), ES modules.
- Express 4, `zod` for every request/response/env schema, `mongoose` 8 on a
  MongoDB **replica set** (transactions are used for sample lock and bulk import).
- `jose` verifies Keycloak access tokens against the realm JWKS.
- `pino` logging, `node-cron` scheduler, `nodemailer` e-mail, `papaparse` CSV,
  `date-fns` + `date-fns-tz` for cycle windows, `vitest` + `supertest` tests
  against the real database.
- One package, no monorepo. `npm` scripts: `dev`, `build`, `start`, `test`,
  `typecheck`, `lint`, `seed`, `seed:demo`.

## 1a. Principles (binding)

- **Feature-driven.** Code is organised by business capability
  (`modules/cycles`, `modules/sampling`), never by technical layer across the
  whole app. A feature owns its model, validation, service, routes, jobs,
  templates and tests. Cross-feature calls go through the other feature's
  exported service functions, never its model.
- **Single responsibility.** One file, one job: `*.model.ts` describes
  storage; `*.schemas.ts` describes the wire; `*.service.ts` holds the rules
  and takes `ctx` plus typed input (it never touches `req`/`res`); `*.routes.ts`
  only parses, authorises and delegates; `jobs/*` only schedules and calls
  services. A function that needs a comment to list what it does is two
  functions. No "utils" dumping ground: shared helpers live in `core/` under a
  name that says what they do.
- **Explicit over clever.** No global request state beyond `req.ctx`, no
  mongoose middleware that silently rewrites queries; scoping is a visible
  argument. Boot fails loudly on a misconfigured route or environment.

## 2. Layout

```
src/
  server.ts            boot: env → db → app → scheduler → listen; graceful shutdown
  app.ts               express app factory (helmet, cors, json, request id, pino-http, routers, error handler)
  config/env.ts        the ONLY reader of process.env (zod; exits listing every bad variable)
  core/
    db.ts              connect, transactions helper `withTransaction(fn)`
    errors.ts          AppError + the error-code table (code → HTTP status)
    http.ts            `route()` helper: zod-validated params/query/body, typed handler, async errors
    logger.ts
    auth/keycloak.ts   bearer JWT verification (RS256, iss, aud); `authenticate` middleware
    auth/session.ts    resolves user + memberships → `req.ctx` (see §4)
    auth/rbac.ts       `requireTask('cycles.manage')`, `requireScope('PLATFORM'|'ACO'|'AIRPORT')`
    auth/link.ts       participant / registration link sessions (HS256 JWT) → `req.link`
    audit.ts           `audit(ctx, { action, entity, entityId, before, after })`
    mailer.ts          transport (SMTP or LOG), `send(template, to, vars)` → notifications log
    templates/         e-mail templates (subject + text + minimal HTML), one file each
    scheduler.ts       node-cron every minute → `jobs/*` runners, idempotent through `jobs`
    pagination.ts      `?page=1&pageSize=25&sort=-createdAt&q=` helpers, `{ data, meta }`
    ids.ts             ObjectId ↔ string, `toId()` validation
  modules/<name>/
    <name>.model.ts    mongoose schema + indexes
    <name>.schemas.ts  zod request/response schemas (exported for OpenAPI)
    <name>.service.ts  business logic; takes `ctx`, never reads req/res
    <name>.routes.ts   express Router built with `route()`; policy on every route
    index.ts           `{ router, basePath, tasks: TaskDefinition[] }`
  modules/index.ts     registers modules; boot fails if a route has no policy or
                       names a task its module did not declare
  jobs/                cycle transitions, reminders, invitation expiry, scoring runs
  seed/                reference data (airports, surveys, roles, tasks, matrix), demo dataset
test/                  vitest; `test/helpers` builds a signed-in context without Keycloak
docs/
```

Modules (in dependency order): `identity` (users, roles, tasks, matrix,
memberships, me), `airports`, `organisations` (ACFI, ACO, airport orgs; market
share), `onboarding` (links, registrations, approval), `surveys` (categories,
subcategories, questions, versions), `cycles` (cycles, participants, windows,
reminders, transitions), `customers` (FF/CB directory, bulk import),
`sampling` (selection, lock, unlock, audit), `invitations` (tokens, OTP,
participant sessions), `assessments` (responses, drafts, submit; self
assessment), `scoring` (scores, airport roll-up, rankings), `reports`
(dashboards, monitoring, comparisons, exports), `notifications` (log, resend),
`audit`, `settings`.

## 3. Conventions

- **Responses.** Success: `{ data }` or `{ data, meta: { page, pageSize, total } }`.
  Error: `{ error: { code, message, details?, requestId } }`. Codes:
  `VALIDATION` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404,
  `CONFLICT` 409, `PRECONDITION_FAILED` 412, `RATE_LIMITED` 429, `LINK_EXPIRED`
  410, `OTP_INVALID` 400, `INTERNAL` 500. Stack traces never leave the server.
- **Ids** are Mongo ObjectIds serialised as `id` strings. Every document has
  `createdAt`, `updatedAt`; soft-deletable ones have `status`.
- **Dates** are ISO-8601 UTC strings on the wire. Cycle windows are entered as
  wall-clock date + time in the cycle's time zone (default `Asia/Kolkata`) and
  stored with the computed UTC instant alongside.
- **Validation** is zod at the edge; services receive parsed, typed input.
- **Cross-tenant reads return 404**, never 403, so list endpoints cannot be
  used to enumerate other operators. 403 is reserved for "right organisation,
  missing task".
- **Audit** every state change that matters (see §7) with actor, organisation,
  before/after, IP, request id.
- **Tests** cover each service and every flow end to end (`test/flows/*`).

## 4. Identity, roles and tenancy

Keycloak (realm `csq` on `https://auth.tinydata.in/`) authenticates. The CSQ
database authorises.

- `users` `{ keycloakSub?, email (unique, lowercase), name, phone?, status: INVITED|ACTIVE|SUSPENDED, lastLoginAt }`.
  On a verified token: find by `keycloakSub`; else by `email` claim where
  `keycloakSub` is null and status is INVITED/ACTIVE → link and set ACTIVE.
  Unknown identity → 403 `FORBIDDEN` with message "No CSQ account for this
  sign-in". (This lets an administrator create the Keycloak user by hand and
  the app link it on first sign-in; when `KEYCLOAK_ADMIN_*` is configured the
  app creates the Keycloak user itself on approval and sends the set-password
  e-mail through Keycloak's execute-actions endpoint.)
- `roles` `{ code, name, description, scope: PLATFORM|ACO|AIRPORT, system: boolean }`.
  Seeded: `SUPER_ADMIN`, `ACFI_ANALYST` (PLATFORM); `ACO_ADMIN`, `ACO_USER`
  (ACO); `AIRPORT_ADMIN`, `AIRPORT_VIEWER` (AIRPORT). Admins may add roles.
- `tasks` `{ code, module, name, description }` — declared in code by each
  module (`index.ts`), upserted at boot. Codes (final list; add only via a
  module's declaration):
  `airports.view airports.manage · operators.view operators.manage ·
  onboarding.links onboarding.review · surveys.view surveys.manage ·
  marketshare.view marketshare.manage · cycles.view cycles.manage
  cycles.publish cycles.operate · customers.view customers.manage ·
  sampling.view sampling.manage sampling.lock sampling.unlock ·
  assessments.self assessments.view · reports.operator reports.airport
  reports.national · monitoring.view · users.view users.manage · roles.view
  roles.manage · notifications.view notifications.send · audit.view ·
  settings.view settings.manage`.
- `role_tasks` `{ roleId, taskId, enabled }` — the Role → Task matrix. Seeded
  defaults: SUPER_ADMIN everything; ACFI_ANALYST all `*.view` + reports +
  monitoring; ACO_ADMIN customers/sampling (incl. lock)/assessments.self/
  assessments.view/reports.operator/users.view/users.manage (own org)/
  settings.view; ACO_USER customers.view, sampling.view, assessments.self,
  reports.operator; AIRPORT_ADMIN/VIEWER reports.airport (+ users.manage for
  admin). Saving the matrix bumps `settings.rbacVersion`; the RBAC cache keys
  on it.
- `memberships` `{ userId, orgId, roleId, status: ACTIVE|INACTIVE }`. A user
  may belong to several organisations. The active organisation is the header
  `x-csq-org: <orgId>`; without it, the first active membership.
- `req.ctx = { user, org, role, tasks: Set<string>, scope }` where `scope` is
  `{ kind: 'PLATFORM' }` for ACFI organisations, `{ kind: 'ACO', acoId }` or
  `{ kind: 'AIRPORT', airportId }`. Services always filter by scope; a
  PLATFORM scope may pass an explicit `acoId`/`airportId` filter.
- `requireTask(code)` → 403 when the active role lacks the task.

## 5. Data model

Collections and key fields (indexes in brackets).

- `airports` `{ iata, icao?, name, city, state, region, country: 'IN', lat, lng, active }` [iata unique]
- `organisations` `{ type: ACFI|ACO|AIRPORT, code, name, airportId? (ACO), legalName?, address { line1, line2, city, state, pincode }, contact { name, email, phone }, operations: { domestic: boolean, international: boolean }, status: PENDING|ACTIVE|INACTIVE, createdVia: ADMIN|LINK, approvedAt?, approvedBy? }` [code unique; airportId]
- `onboarding_links` `{ tokenHash, orgType: ACO|AIRPORT, airportId?, createdBy, expiresAt, usedAt?, registrationId?, note? }` [tokenHash unique]
- `registrations` `{ linkId?, orgType, airportId, organisation { … same shape as organisations minus status }, admin { name, email, phone }, marketSharePct?, status: SUBMITTED|APPROVED|REJECTED, reviewedBy?, reviewedAt?, reviewNote?, resultOrgId? }` [status, airportId]
- `market_shares` `{ airportId, acoId, cycleId? (null = current default), sharePct, setBy, note }` [airportId+cycleId+acoId unique]. Per airport per cycle the shares must total 100; the API validates the set as a whole.
- `surveys` `{ code: DOMESTIC|INTERNATIONAL, name, version, status: DRAFT|PUBLISHED|RETIRED, publishedAt }`;
  `categories` `{ surveyId, code, name, order, weightPct }`;
  `subcategories` `{ surveyId, categoryId, code, name, order }`;
  `questions` `{ surveyId, categoryId, subcategoryId?, code, text, help?, order, weightPct?, mandatory, commentMode: OPTIONAL|REQUIRED|REQUIRED_ON_LOW|NONE, stakeholderTypes: [FF|CB], followUp?: { prompt, options: string[] } (asked on Fair/Poor), active }`.
  A published survey version is immutable; editing creates the next DRAFT version. A cycle pins `surveyVersions { DOMESTIC?: surveyId, INTERNATIONAL?: surveyId }` at publish.
- `cycles` `{ name, code, type: DOMESTIC|INTERNATIONAL|BOTH, tz, sampling { start, end }, assessment { start, end } (each { wall: 'YYYY-MM-DDTHH:mm', utc: Date }), minSampleSize, reminders { sampling { count, everyDays }, assessment { count, everyDays } }, participatingAirportIds, participatingAcoIds, surveyVersions, status: DRAFT|PUBLISHED|SAMPLING_OPEN|SAMPLING_CLOSED|ASSESSMENT_OPEN|ASSESSMENT_CLOSED|SCORED|ARCHIVED, publishedAt, publishedBy, marketShareFrozen: boolean, scoredAt }` [status, code unique]
- `cycle_participants` `{ cycleId, acoId, airportId, surveyTypes: [DOMESTIC|INTERNATIONAL], requiredSampleSize, sampling { status: NOT_STARTED|IN_PROGRESS|LOCKED|UNLOCKED, selectedCount, lockedAt?, lockedBy?, unlockedAt?, unlockedBy?, unlockReason? }, stats { invited, started, completed }, selfAssessment { DOMESTIC?: status, INTERNATIONAL?: status } }` [cycleId+acoId unique]
- `customers` `{ acoId, airportId, name, contactPerson, email (lowercase), phone, type: FF|CB, surveyType: DOMESTIC|INTERNATIONAL|BOTH, status: ACTIVE|INACTIVE, tags: string[], lastSampledCycleId?, importBatchId? }` [acoId+email unique; acoId+status]
- `customer_imports` `{ acoId, fileName, rows, accepted, rejected, errors: [{ row, field, message }], status: VALIDATED|COMMITTED, createdBy }`
- `samples` `{ cycleId, acoId, customerId, surveyType, state: SELECTED|LOCKED|REMOVED, addedBy, addedAt, removedAt? }` [cycleId+acoId+customerId+surveyType unique]
- `invitations` `{ cycleId, acoId, customerId, surveyType, assessmentId?, tokenHash, state: PENDING|SENT|OPENED|VERIFIED|SUBMITTED|EXPIRED|REVOKED, email, otp { hash, expiresAt, attempts }, sentAt, openedAt, verifiedAt, submittedAt, remindersSent, lastReminderAt, expiresAt }` [tokenHash unique; cycleId+acoId+state]
- `assessments` `{ cycleId, acoId, airportId, surveyId, surveyType, kind: CUSTOMER|SELF, customerId?, customerType?: FF|CB, invitationId?, userId? (SELF), status: DRAFT|SUBMITTED, answers: [{ questionId, rating: 1..5|null, na: boolean, comment?, followUp?: string[] }], answeredCount, questionCount, startedAt, lastSavedAt, submittedAt }` [cycleId+acoId+kind; invitationId unique sparse]
- `scores` `{ cycleId, acoId, surveyType, level: QUESTION|SUBCATEGORY|CATEGORY|OVERALL, refId, customer { mean, n, naCount, byType { FF { mean, n }, CB { mean, n } } }, self { mean, n }, suppressed?: 'INSUFFICIENT_RESPONSES', rank?, rankOf?, previous?: { cycleId, mean }, delta? }` [cycleId+acoId+surveyType+level+refId unique]
- `airport_scores` `{ cycleId, airportId, surveyType, level, refId, mean, marketShareApplied, coveredSharePct, operators: [{ acoId, mean, sharePct, suppressed }], rank, rankOf }`
- `notifications` `{ channel: EMAIL|LOG, template, to, subject, body, vars, refs { cycleId?, acoId?, customerId?, invitationId?, userId? }, status: QUEUED|SENT|FAILED, error?, sentAt, resendOf? }` [refs.cycleId, status]
- `jobs` `{ type, refId, slot, status: DONE|FAILED, ranAt, detail }` [type+refId+slot unique] — the scheduler's idempotency record.
- `audit_log` `{ actorUserId?, actorEmail?, orgId?, action, entity, entityId, before?, after?, ip, requestId, at }` [entity+entityId, orgId+at]
- `settings` single document `{ scoring { minResponses: 3, weightingMode: EQUAL|WEIGHTED }, defaults { samplingDays: 10, assessmentDays: 30, reminders { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } }, tz: 'Asia/Kolkata' }, branding { orgName: 'Air Cargo Forum India' }, rbacVersion }`

## 6. API contract

Base `/api/v1`. Every route lists its policy: `public`, `link` (participant or
registration link session), or a task code. All `[list]` endpoints accept
`page, pageSize, sort, q` and return `{ data, meta }`.

### identity
- `GET /me` (any signed-in user) → `{ user, memberships: [{ orgId, orgName, orgType, roleCode, airportId? }], active: { orgId, roleCode, tasks: string[] , scope } }`
- `GET /users` [list] `users.view` (PLATFORM: all; ACO/AIRPORT: own org's members) → `{ id, name, email, phone, status, memberships[] , lastLoginAt }`
- `POST /users` `users.manage` body `{ name, email, phone?, orgId, roleCode }` → creates user INVITED + membership; sends invite e-mail (Keycloak user created when admin API configured).
- `PATCH /users/:id` `users.manage` `{ name?, phone?, status? }` · `POST /users/:id/memberships` `{ orgId, roleCode }` · `DELETE /users/:id/memberships/:membershipId`
- `GET /roles` `roles.view` → roles with task counts · `POST /roles` `roles.manage` `{ code, name, description, scope }` · `PATCH /roles/:id`
- `GET /roles/matrix` `roles.view` → `{ tasks: [{ code, module, name, description }], roles: [{ id, code, name, scope, system, tasks: string[] }] }`
- `PUT /roles/matrix` `roles.manage` `{ roles: [{ roleId, tasks: string[] }] }` → whole-matrix save, audited.

### airports
- `GET /airports` [list] `airports.view` (filters `active`, `region`) · `GET /airports/:id` (includes operators + current market shares)
- `POST /airports` · `PATCH /airports/:id` `airports.manage` · `POST /airports/import` (CSV) `airports.manage`

### organisations
- `GET /operators` [list] `operators.view` (filters `airportId`, `status`) → ACO summaries `{ id, code, name, airport { id, iata, name }, operations, status, memberCount, customerCount, currentShare? }`
- `POST /operators` `operators.manage` `{ code, name, airportId, operations, address, contact, admin { name, email, phone }, marketSharePct? }` → creates ACTIVE org + INVITED admin user.
- `GET /operators/:id` (PLATFORM any; ACO own) · `PATCH /operators/:id` `operators.manage` · `POST /operators/:id/deactivate`
- `GET /airports/:id/market-share?cycleId=` `marketshare.view` → `{ airportId, cycleId?, entries: [{ acoId, name, sharePct }], total, frozen }`
- `PUT /airports/:id/market-share` `marketshare.manage` `{ cycleId?: string|null, entries: [{ acoId, sharePct }] }` → validates total = 100 (±0.01), refuses when the cycle is frozen.

### onboarding
- `POST /onboarding/links` `onboarding.links` `{ orgType, airportId?, expiresInDays = 14, note? }` → `{ id, url, expiresAt }` (the raw token only in this response) · `GET /onboarding/links` [list] · `DELETE /onboarding/links/:id`
- `GET /public/onboarding/:token` public → `{ orgType, airport?: { id, iata, name }, expiresAt, used }` (404 unknown, 410 expired)
- `POST /public/onboarding/:token` public, body = registration form (`organisation`, `admin`, `operations`, `marketSharePct?`) → `{ registrationId }`; e-mail "request received" to admin; notifies ACFI.
- `GET /registrations` [list] `onboarding.review` (filter `status`) · `GET /registrations/:id`
- `POST /registrations/:id/approve` `onboarding.review` `{ code, marketSharePct?, note? }` → creates organisation ACTIVE, admin user INVITED, membership ACO_ADMIN, e-mail "account approved"; `POST /registrations/:id/reject` `{ note }`.

### surveys
- `GET /surveys` `surveys.view` → both survey types with their versions · `GET /surveys/:id` → full tree `{ survey, categories: [{ …, subcategories: [{ …, questions[] }], questions[] }] }`
- `POST /surveys/:id/versions` `surveys.manage` → new DRAFT copied from the latest · `POST /surveys/:id/publish` → PUBLISHED (immutable)
- Draft editing: `POST|PATCH|DELETE /surveys/:id/categories/:catId`, `…/subcategories/:subId`, `…/questions/:qId`, `PUT /surveys/:id/order` `{ categories: [{ id, order, subcategories: [{ id, order, questions: [{ id, order }] }] }] }`.
- `GET /surveys/:id/preview?stakeholderType=FF` → the form exactly as an assessor sees it.

### cycles
- `GET /cycles` [list] `cycles.view` (PLATFORM: all; ACO: cycles it participates in) → `{ id, code, name, type, status, sampling, assessment, minSampleSize, participants { airports, operators }, progress { locked, invited, completed } }`
- `POST /cycles` `cycles.manage` (DRAFT) body `{ name, code, type, tz?, initiationDate?, sampling { start, end }, assessment { start, end }, minSampleSize, reminders, participatingAirportIds, participatingAcoIds, surveyVersions? }` — when `initiationDate` is given and windows are omitted the server derives them from `settings.defaults`.
- `GET /cycles/:id` → cycle + participants list (`cycle_participants` joined with operator + airport) + survey versions + market-share frozen flag · `PATCH /cycles/:id` (DRAFT only; PUBLISHED allows extending end dates and reminder settings, audited)
- `POST /cycles/:id/publish` `cycles.publish` → validations: windows ordered, every participating airport's market shares total 100 (snapshot copied to `market_shares` with `cycleId`), surveys published; creates `cycle_participants`; e-mails ACO admins ("Commencement of assessment cycle"); status PUBLISHED (or SAMPLING_OPEN if the sampling window already started).
- `POST /cycles/:id/transition` `cycles.operate` `{ to: SAMPLING_OPEN|SAMPLING_CLOSED|ASSESSMENT_OPEN|ASSESSMENT_CLOSED|SCORED|ARCHIVED, reason }` → manual, audited override of the clock (the scheduler performs the same transitions automatically at the window instants).
- `GET /cycles/:id/participants` [list] `cycles.view` → per-ACO sampling + assessment progress · `GET /cycles/:id/monitoring` `monitoring.view` → `{ sampling { airports, operators, sampleRequired, sampleLocked, lockedOperators }, assessment { invited, started, completed, pending, completionRate }, byAirport: [{ airportId, iata, name, operators: [{ acoId, name, sampling, invited, completed }] }] }`
- `POST /cycles/:id/reminders/send` `cycles.operate` `{ kind: SAMPLING|ASSESSMENT, acoId? }` → manual reminder run (otherwise scheduled).
- `GET /cycles/current` `cycles.view` → the cycle(s) an ACO must act on now, with the cycle strip data `{ cycle, participant, nextDeadline { kind, at } }`.

### customers (ACO scope; PLATFORM may pass `acoId`)
- `GET /customers` [list] `customers.view` (filters `type, surveyType, status, tag`) · `POST /customers` `customers.manage` · `GET /customers/:id` · `PATCH /customers/:id` · `POST /customers/:id/deactivate` · `POST /customers/:id/reactivate`
- `GET /customers/import/template` → CSV template · `POST /customers/import/validate` (multipart CSV) → `{ importId, rows, accepted, rejected, errors[], preview[] }` · `POST /customers/import/:importId/commit` → creates/updates customers (transaction).
- `GET /customers/:id/participation` → cycles the customer was sampled in and whether they submitted.

### sampling (ACO scope)
- `GET /sampling/cycles/:cycleId` `sampling.view` → `{ participant, required, selectedCount, lockable: boolean, shortfallRule: 'SELECT_ALL'|null, eligibleCount, selection: [{ customer, surveyType, state }] }`
- `PUT /sampling/cycles/:cycleId/selection` `sampling.manage` `{ add: [{ customerId, surveyType }], remove: [...] }` (only while sampling is open and not locked)
- `POST /sampling/cycles/:cycleId/select-all` `sampling.manage` (allowed when eligible < required)
- `POST /sampling/cycles/:cycleId/lock` `sampling.lock` → transaction: requires selectedCount ≥ required (or eligible < required and all selected); samples → LOCKED; participant LOCKED; invitations PENDING created; audit; e-mail confirmation.
- `POST /sampling/cycles/:cycleId/unlock` `sampling.unlock` (PLATFORM only) `{ reason }` → UNLOCKED; PENDING invitations revoked; audit. Re-lock through `/lock`.
- `GET /sampling/cycles/:cycleId/audit` `sampling.view` → audit entries for this participant.

### invitations
- `GET /invitations` [list] `cycles.view` (filters `cycleId, acoId, state`) → masked e-mail, state, timestamps, remindersSent
- `POST /invitations/:id/resend` `notifications.send` → regenerates token, re-sends the link (audited)
- `POST /invitations/:id/revoke` `sampling.manage`

### public participant flow (`/public/assess`)
- `GET /public/assess/:token` public → `{ state, cycle { name, assessmentEnd }, operator { name, airport { iata, name } }, surveyType, customer { nameMasked, emailMasked }, submittedAt? }` (404 unknown; state EXPIRED after `expiresAt`). Moves SENT → OPENED.
- `POST /public/assess/:token/otp` public, rate-limited 3/10 min → `{ sent: true, devOtp? }` (`devOtp` only when `DEMO_REVEAL_OTP=true`).
- `POST /public/assess/:token/verify` `{ otp }` → `{ sessionToken, expiresAt }` (HS256, 12 h, `{ inv, asg, aco }`); 5 wrong attempts → `OTP_INVALID` until a new OTP is requested.
- With header `x-csq-link-token`: `GET /public/assess/:token/form` → `{ survey, categories → subcategories → questions }` filtered to the customer's stakeholder type; `GET …/draft` → answers; `PATCH …/answers` `{ answers: [{ questionId, rating?, na?, comment?, followUp? }] }` (merge; returns progress); `GET …/readiness` → `{ answered, total, missing: [questionId] }`; `POST …/submit` → SUBMITTED (locks; invitation SUBMITTED; participant stats; e-mail thank-you).

### assessments (signed-in)
- `GET /assessments` [list] `assessments.view` (filters `cycleId, acoId, kind, status, customerType`) → history grid rows `{ id, cycle, kind, customerType, assessorName, assessorEmailMasked, status, submittedAt, score }`
- `GET /assessments/:id` → read-only return (answers with question text); customer identity masked for ACO users unless `settings.revealAssessorIdentity`.
- `GET /assessments/self/:cycleId/:surveyType` `assessments.self` → the ACO's self-assessment (created on first access) · `PATCH …/answers` · `POST …/submit`.
- `GET /assessments/export?cycleId=` `assessments.view` → CSV.

### scoring and reports
- `POST /scoring/cycles/:cycleId/run` `cycles.operate` → recompute all scores for the cycle (idempotent; also run automatically at ASSESSMENT_CLOSED and nightly while open for live dashboards, flagged `provisional`).
- `GET /reports/operator/:acoId?cycleId=` `reports.operator` (ACO: own only) → dashboard payload: `{ cycle, operator, overall { customer { mean, n }, self { mean }, rank, rankOf, suppressed? }, comparison { current, previous }, feedbackDistribution: [{ rating, label, count, pct }], categories: [{ code, name, customer, self, previous, delta, subcategories[] }], byStakeholder { FF, CB }, assessorStats { total, completed, inProgress, yetToStart }, nationalTable: [{ airportIata, airportName, rating, rank }] }`
- `GET /reports/operator/:acoId/questions?cycleId=` → question-level table with comments count
- `GET /reports/airport/:airportId?cycleId=` `reports.airport` → weighted airport score, operators table (platform/airport only), categories
- `GET /reports/national?cycleId=&surveyType=` `reports.national` → airports ranked, operators ranked, category averages, participation
- `GET /reports/comparison?acoId=&cycleIds=a,b` `reports.operator` → side-by-side
- `GET /reports/export?scope=&cycleId=` → CSV/XLSX

### notifications, audit, settings
- `GET /notifications` [list] `notifications.view` (filters `cycleId, acoId, template, status`) · `POST /notifications/:id/resend` `notifications.send`
- `GET /audit` [list] `audit.view` (filters `entity, entityId, orgId, actor, from, to`)
- `GET /settings` `settings.view` · `PATCH /settings` `settings.manage`
- `GET /health` public `{ status, mongo, scheduler, version }`

## 7. Flows and rules

- **Onboarding.** Link (14 d) → form → `registrations` SUBMITTED → ACFI reviews
  (sees airport's current market-share total) → approve creates the
  organisation, the admin user and sends credentials/set-password. Market
  shares at an airport must total 100 before a cycle that includes it can be
  published; the approval screen shows the running total and the API refuses a
  publish that breaks it.
- **Cycle clock** (scheduler, every minute, in the cycle's tz): `sampling.start`
  → SAMPLING_OPEN (e-mail ACO admins); `sampling.end` → SAMPLING_CLOSED
  (operators not locked are listed for ACFI; ACFI may extend); `assessment.start`
  00:00 → ASSESSMENT_OPEN: every PENDING invitation of LOCKED participants gets
  a token and the invitation e-mail; `assessment.end` → ASSESSMENT_CLOSED →
  scoring run → SCORED. Reminders: sampling reminders to unlocked ACO admins
  every `everyDays` up to `count`; assessment reminders to invitations not
  SUBMITTED, same rule; reminders stop on lock / submit.
- **Sampling.** Eligible customers = ACTIVE, surveyType matches the cycle type
  (BOTH matches either; a BOTH customer in a BOTH cycle yields two samples, one
  per survey type). Counter `selected / required`. Lock refused below the
  minimum unless eligible < required and everything eligible is selected.
  Lock is a transaction. Unlock is ACFI-only, reasoned and audited.
- **Participant link.** Token: 32 random bytes, base64url, stored hashed. OTP:
  6 digits, 10 min, 5 attempts, resend after 30 s, 3 per 10 min. Session JWT
  12 h. Link expires at `assessment.end`; after that the page shows "closed".
  One invitation ⇒ one assessment; submitted answers are read-only.
- **Form rules.** Every active question must be answered (rating or NA);
  comment required when `commentMode` says so (REQUIRED_ON_LOW ⇒ Fair/Poor);
  follow-up options shown on Fair/Poor. Progress = answered / total. Autosave
  is a merge PATCH; the client may batch.
- **Scoring.** Rating values 1–5 (Poor=1 … Excellent=5). NA excluded:
  mean over non-NA ratings. Question score = mean over SUBMITTED CUSTOMER
  assessments. Subcategory = (weighted) mean of its questions; category =
  (weighted) mean of its subcategories/questions; overall = (weighted) mean of
  categories (`weightPct` when `weightingMode: WEIGHTED`, else equal). A level
  is `suppressed` when `n < settings.scoring.minResponses`. SELF is computed
  separately and never enters customer figures or rankings. `byType` splits
  FF / CB. Ranks: dense ranking on the overall customer mean (2 dp) among
  operators in the cycle with a non-suppressed score (`rankOf` = that count).
  Airport score = Σ operator mean × sharePct over operators with a score,
  normalised by the covered share (`coveredSharePct`); `marketShareApplied` is
  false when no snapshot exists (equal weights). Previous-cycle values and
  deltas come from the most recent SCORED cycle of the same type.
- **Confidentiality.** An ACO reads only its own operator report; the national
  table it sees carries airport ratings and ranks, never another operator's
  figures. Platform roles see everything.
- **Audit** actions: `registration.submitted/approved/rejected`,
  `operator.created/updated/deactivated`, `marketshare.updated`,
  `survey.published`, `cycle.created/updated/published/transitioned`,
  `customer.created/updated/deactivated/imported`, `sample.selection.changed`,
  `sample.locked/unlocked`, `invitation.sent/resent/revoked`,
  `assessment.submitted`, `scoring.run`, `roles.matrix.saved`,
  `user.created/updated`, `settings.updated`, `notification.resent`.

## 8. Environment

```
NODE_ENV PORT MONGO_URI LOG_LEVEL
KEYCLOAK_ISSUER KEYCLOAK_JWKS_URI KEYCLOAK_AUDIENCE
KEYCLOAK_ADMIN_URL? KEYCLOAK_ADMIN_CLIENT_ID? KEYCLOAK_ADMIN_CLIENT_SECRET?   (optional user provisioning)
CORS_ORIGINS PUBLIC_WEB_URL
LINK_SESSION_SECRET (≥32 chars)
SMTP_URL? MAIL_FROM            (no SMTP_URL ⇒ e-mails are written to the notifications log only)
DEMO_REVEAL_OTP=false
SCHEDULER_ENABLED=true
```
