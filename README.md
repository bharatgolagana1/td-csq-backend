# CSQ backend

API for the Cargo Service Quality survey platform of Air Cargo Forum India.
Node ≥ 22, TypeScript, Express 4, mongoose 8 on a MongoDB replica set, zod,
Keycloak for identity. The design is in `docs/ARCHITECTURE.md` (binding) and
the product requirements in `docs/REQUIREMENTS.md`.

## Run

```sh
cp .env.example .env            # edit MONGO_URI / Keycloak values if yours differ
npm install
npm run seed -- --super-admin email=you@example.com name="Your Name"
npm run dev                     # http://localhost:4000/api/v1/health
```

MongoDB must be a replica set (`mongodb://127.0.0.1:27017/csq?replicaSet=rs0`
locally); transactions are used. `npm run build && npm start` runs the
compiled app from `dist/`.

## Environment

Every variable is listed and explained in `.env.example`; `src/config/env.ts`
validates them at boot and exits listing every problem. Without `SMTP_URL`
e-mails are written to the `notifications` collection and the log only.
`SCHEDULER_ENABLED=false` turns the minute tick off.

## Seed

`npm run seed` upserts the tasks declared by the registered modules, the six
system roles, the default Role → Task matrix (§4 of the architecture), the
settings document, the ACFI organisation and the Indian airport list (the 14
Phase-I airports active). It never overwrites what an administrator changed:
re-run it after adding a module so new tasks get their default grants.

`--super-admin email=… name=…` creates (or keeps) the first `SUPER_ADMIN`
user as INVITED. `npm run seed:demo` is a placeholder until the cycle modules
exist.

## First sign-in

Keycloak authenticates; the CSQ database authorises. Create the user in the
Keycloak realm (`deploy/keycloak/`) with the same e-mail you passed to
`--super-admin`. On the first request with that token the API finds the
INVITED account by e-mail, stores the Keycloak `sub` and activates it. Any
identity without a CSQ account gets `403 FORBIDDEN "No CSQ account for this
sign-in"`. The active organisation is the `x-csq-org: <orgId>` header, else
the first active membership.

## Tests

`npm test` runs vitest against a real database, one file at a time. The
environment comes from the real environment, then `.env.test`, then `.env`,
then built-in defaults (`test/setup.ts`); whatever the source, the database
name is forced to end in `_test` (`csq_test` by default). `test/helpers/app.ts`
gives you `createTestApp()` (fresh database + core seed + app with a fake
token verifier) and `asUser({ orgType, roleCode, email? })`, a supertest client
signed in as that user. `npm run typecheck`, `npm run lint`, `npm run build`
and `npm test` must all pass before a change is done.

## Writing a module

Look at `src/modules/organisations` for the shape: `*.model.ts` (storage),
`*.schemas.ts` (wire), `*.service.ts` (rules; takes `ctx`), `*.routes.ts`
(parse → authorise → delegate), `index.ts`. Then:

- **Register it** in `src/modules/index.ts` (`modules` array, dependency
  order). Boot refuses a route without a policy, a task the module did not
  declare, or a duplicate task/route.
- **Declare tasks** in `index.ts` (`{ code: 'cycles.manage', name, description }`,
  code `module.verb`). They are upserted into `tasks` at boot; the default
  matrix patterns in `src/seed/matrix.ts` decide which roles get them on the
  next `npm run seed`.
- **Routes** use `route({ method, path, policy, params?, query?, body?,
  response?, status?, before?, handler })` from `src/core/http.ts`. Policies:
  `{ kind: 'task', task }` (normal), `{ kind: 'session' }` (any signed-in
  user), `{ kind: 'link', audience: 'participant' | 'registration' }`,
  `{ kind: 'public' }`. The handler returns the `data` payload; return a `Page`
  from `pageOf()` for `[list]` endpoints, `undefined` for 204.
- **Scope** every query with `ctx.scope` (`PLATFORM` | `ACO { acoId }` |
  `AIRPORT { airportId }`). Combine a scope filter with request filters through
  `and()` from `src/core/filters.ts`, never by spreading. Cross-tenant reads are
  404, never 403.
- **Audit** with `audit(ctx, { action, entity, entityId, before?, after?,
  orgId? })` from `src/modules/audit/audit.service.ts`; pass `null` as ctx for
  system actions.
- **E-mail** with `send({ template, to, vars, refs })` from
  `src/modules/notifications/notifications.service.ts`; add templates as one
  file each under `notifications/templates/` and register them in
  `templates/index.ts`.
- **Jobs**: write `src/jobs/<feature>.job.ts`, register it in
  `src/jobs/index.ts`, and wrap every unit of work in
  `once(type, refId, slot, fn)` so a tick never repeats it.
- **Transactions**: `withTransaction(async (session) => …)`; every operation
  inside must pass `session`. A write outside the session to a document the
  transaction also writes makes the driver retry forever.
- **Hook points** the foundation leaves for you: `registerCustomerCounter()`
  (organisations → customers) and `registerMarketShareFreezeCheck()`
  (organisations → cycles).

## Routes (foundation)

All under `/api/v1`; policy in brackets.

| Method | Path | Policy |
|---|---|---|
| GET | `/health` | public |
| GET | `/me` | session |
| GET, POST | `/users` | users.view, users.manage |
| PATCH | `/users/:id` | users.manage |
| POST | `/users/:id/memberships` · DELETE `/users/:id/memberships/:membershipId` | users.manage |
| GET, POST | `/roles` | roles.view, roles.manage |
| PATCH | `/roles/:id` | roles.manage |
| GET, PUT | `/roles/matrix` | roles.view, roles.manage |
| GET, POST | `/airports` | airports.view, airports.manage |
| POST | `/airports/import` (multipart `file` or `text/csv`) | airports.manage |
| GET, PATCH | `/airports/:id` | airports.view, airports.manage |
| GET, PUT | `/airports/:id/market-share` | marketshare.view, marketshare.manage |
| GET, POST | `/operators` | operators.view, operators.manage |
| GET, PATCH | `/operators/:id` · POST `/operators/:id/deactivate` | operators.view, operators.manage |
| GET, PATCH | `/settings` | settings.view, settings.manage |
| GET | `/audit` | audit.view |
| GET | `/notifications` · POST `/notifications/:id/resend` | notifications.view, notifications.send |

## Assessments

What an assessor answers (`src/modules/assessments`; REQUIREMENTS §17,
ARCHITECTURE §5 `assessments`, §6 "public participant flow" and
"assessments", §7 "Form rules"). One `assessments` document per invitation
(CUSTOMER) or per operator, cycle and survey type (SELF); `surveyId` is the
version the cycle pinned at publish, `customerType` the customer's FF / CB.
The form is the surveys module's stakeholder form served unchanged
(`{ survey, stakeholderType, scale, questionCount, categories: [{ …,
questions, subcategories: [{ …, questions }] }] }`), wrapped with the
`assessment` and its `progress { answered, total, pct }`; a self-assessment
carries every active question (`stakeholderType: null`). Answers are
validated against that form (`assessments.form.ts`, pure): the question must
be on the form, exactly one of `rating` 1–5 / `na`, a comment when
`commentMode` is REQUIRED (or REQUIRED_ON_LOW with a Fair / Poor rating),
none when NONE, follow-up options only on Fair / Poor and only from the
question's list. A PATCH is a merge by question (the client may batch); a
batch with one bad entry is refused whole with `details.issues[{ path,
message }]`. Submit needs every question answered (412 with
`details.missing`), locks the assessment (every later write is 412), emits
`assessment.submitted` inside the same transaction (cycles counts the
participant's completion / self-assessment status, invitations marks the
invitation; a failing listener rolls the submit back) and audits
`assessment.submitted`. Tasks: `assessments.self`, `assessments.view`.

| Method | Path | Policy |
|---|---|---|
| GET | `/assessments` [list] (filters `cycleId, acoId, kind, status, customerType, surveyType`; sort `startedAt, submittedAt, status, kind, surveyType, customerType, createdAt`) → history rows | assessments.view |
| GET | `/assessments/export?cycleId=&acoId?&kind?&status?` → CSV, one line per assessment and form question | assessments.view |
| GET | `/assessments/:id` → history row + `survey` + `answers: [{ questionId, code, text, category, subcategory, rating, na, comment, followUp }]` | assessments.view |
| GET | `/assessments/self/:cycleId/:surveyType` → form + `answers` (created on first access; ACO scope; only while the cycle is SAMPLING_OPEN … ASSESSMENT_OPEN and the operator runs that survey type) | assessments.self |
| PATCH | `/assessments/self/:cycleId/:surveyType/answers` (`{ answers: [{ questionId, rating?, na?, comment?, followUp? }] }`) → `{ answered, total, pct, lastSavedAt }` | assessments.self |
| POST | `/assessments/self/:cycleId/:surveyType/submit` → the assessment | assessments.self |

History rows: `{ id, cycle { id, code, name }, operator { id, code, name },
kind, surveyType, customerType, customerId, assessorName,
assessorEmailMasked, assessor { name, email, revealed }, status, progress,
startedAt, submittedAt, score }` where `score` is the assessment's own
NA-excluding mean rating (1 dp). Scope: PLATFORM everything, ACO its own
operator, AIRPORT the operators at its airport; cross-tenant ids are 404.
The assessor (the customer's contact) is masked (`A*** R***`,
`a***@domain`) unless the caller is a platform role or
`settings.revealAssessorIdentity` is on; a self-assessment names the
operator's own user and is never masked. The public participant routes
(`/public/assess/:token/…`, in invitations) call the exported functions:
`getOrCreateForInvitation(invitation)` (idempotent), `getForm(assessmentId)`,
`getDraft(assessmentId)`, `patchAnswers(assessmentId, answers)`,
`readiness(assessmentId)` → `{ answered, total, missing, complete }`,
`submit(ctx | link, assessmentId)`; also `getOrCreateSelf(ctx, cycleId,
surveyType)` and `listSubmitted(cycleId, acoId, kind?)` (the scoring engine's
`SubmittedAssessment` plus identifiers). Events emitted:
`assessment.submitted`. No listeners, no jobs.

## Customers

The FF / CB directory of an operator (`src/modules/customers`). ACO scope:
every query is filtered by the caller's operator; PLATFORM may pass `acoId`
(required on create and import). Cross-operator ids are 404. Field rules
(name, contact, e-mail, phone → E.164, tags) come from
`customers/domain/normalise.ts`; the CSV template and validation from
`csvTemplate.ts` / `csvValidate.ts`. One e-mail per customer per operator;
a clash is `409 CONFLICT` with the holder's `customerId` in `details`.

| Method | Path | Policy |
|---|---|---|
| GET, POST | `/customers` (filters `type, surveyType, status, tag, acoId`; `q` over name, e-mail, contact) | customers.view, customers.manage |
| GET, PATCH | `/customers/:id` · POST `/customers/:id/deactivate` · POST `/customers/:id/reactivate` | customers.view, customers.manage |
| GET | `/customers/import/template` (CSV download, two example rows) | customers.view |
| POST | `/customers/import/validate` (multipart `file` or `text/csv`; `?acoId=&fileName=`) → `customer_imports` VALIDATED | customers.manage |
| POST | `/customers/import/:importId/commit` (transaction; 409 when already committed) | customers.manage |

Exported to higher modules: `getCustomer(acoId, id)`, `listEligible(acoId,
cycleType, participantSurveyTypes?)` (sampling domain `eligibleCustomers`),
`countByAco(acoId)` / `countByAcos(acoIds)` (registered as the organisations
customer counter at boot), `emailsByAco(acoId)`, `markLastSampled(acoId,
customerIds, cycleId, session?)`. Audit: `customer.created/updated/
deactivated/imported` (reactivation is a `customer.updated`). No events, no
jobs.

## Invitations

The participant flow (`src/modules/invitations`; REQUIREMENTS §15–18,
ARCHITECTURE §5 `invitations`, §6 "invitations" + "public participant flow",
§7 "Participant link"). One invitation per locked sample
(cycle + operator + customer + surveyType; a REVOKED one is history and does
not block a re-lock). The pure rules in `invitations/domain` decide everything:
`token` (32 random bytes base64url, stored as a sha256 hash; six-digit OTP;
`maskEmail` / `maskName`), `otpPolicy` (10 min, 5 attempts, 30 s cooldown,
3 per 10 min) and `states` (PENDING → SENT → OPENED → VERIFIED → SUBMITTED,
with RESEND, EXPIRE and REVOKE edges).

| Method | Path | Policy |
|---|---|---|
| GET | `/invitations` [list] (`?cycleId=&acoId=&state=&surveyType=&q=`) → masked rows | session + `cycles.view` |
| POST | `/invitations/:id/resend` → new token, SENT, e-mail again; the old link dies (audit `invitation.resent`) | session + `notifications.send` |
| POST | `/invitations/:id/revoke` → REVOKED, terminal (audit `invitation.revoked`) | session + `sampling.manage` |
| GET | `/public/assess/:token` → `{ state, cycle { id, name, assessmentEnd }, operator { name, airport { iata, name } }, surveyType, customer { nameMasked, emailMasked }, submittedAt, expiresAt }`; SENT → OPENED; `state` is EXPIRED once past `expiresAt`; unknown token 404 | public |
| POST | `/public/assess/:token/otp` → `{ sent: true, expiresAt, devOtp? }` (`devOtp` only with `DEMO_REVEAL_OTP=true`); 429 `RATE_LIMITED` with `details { reason: COOLDOWN \| RATE_LIMITED \| ADDRESS, retryAfterMs }` | public |
| POST | `/public/assess/:token/verify` `{ otp }` → `{ sessionToken, expiresAt, assessmentId }` (HS256, 12 h, claims `{ inv, asg, aco }`); 400 `OTP_INVALID` with `details { reason: NO_OTP \| EXPIRED \| LOCKED \| MISMATCH \| CONSUMED, attemptsLeft }` | public |
| GET | `/public/assess/:token/form` → assessments' form (`{ assessment, survey, categories, progress }`) | link:participant |
| GET | `/public/assess/:token/draft` → `{ id, status, answers, progress, lastSavedAt, submittedAt }` | link:participant |
| PATCH | `/public/assess/:token/answers` `{ answers: [{ questionId, rating?, na?, comment?, followUp? }] }` → `{ answered, total, pct, lastSavedAt }` (merge; 412 once submitted) | link:participant |
| GET | `/public/assess/:token/readiness` → `{ answered, total, missing, complete }` | link:participant |
| POST | `/public/assess/:token/submit` → `{ state: 'SUBMITTED', submittedAt, assessment }` | link:participant |

The signed-in routes carry a `session` policy and assert the §6 task in the
handler, because the registry admits a task policy only for the module's own
tasks and the matrix already grants those codes. The link routes run with the
session's `x-csq-link-token`: the session must name the invitation of the URL
(`inv`) and its assessment (`asg`), the invitation must be VERIFIED (SUBMITTED
keeps form and draft readable) and inside the window; a mismatch is 404, a
missing or stale session 401, a closed window 410 `LINK_EXPIRED`. Every public
handler runs under a system context scoped to the invitation's operator;
form, draft, answers, readiness and submit delegate to the assessments service
with the session's assessment id. Resend, reminder and expiry links: a reminder
carries a fresh link and the earlier links stay valid (`previousTokenHashes`;
the raw token is never stored, so it cannot be repeated); a resend clears them.
The OTP hash is scoped by the invitation id so a code in flight survives a
reminder.

Events: listens to `sample.locked` (inside the lock transaction: PENDING
invitations, idempotent), `sample.unlocked` (PENDING → REVOKED, audited; sent
links keep working), `cycle.transitioned` to ASSESSMENT_OPEN (`activateCycle`:
token + `assessment-invitation` e-mail with `${PUBLIC_WEB_URL}/assess/<token>`
for every PENDING invitation of a LOCKED participant, audit `invitation.sent`,
`once('invitation.send', invitationId, 'activate')`) and `assessment.submitted`
with `kind: CUSTOMER` (inside assessments' transaction: SUBMITTED +
`assessment-thank-you`). Emits `invitation.sent` (cycles counts
`stats.invited`); the first verification bumps `stats.started`. Registers its
`sendReminders` into cycles' `registerAssessmentReminderSender`, so
`POST /cycles/:id/reminders/send { kind: 'ASSESSMENT', acoId? }` sends the next
reminder now. Exported: `createPendingForSamples(payload)`,
`activateCycle(cycleId)`, `revokePending(cycleId, acoId)`,
`sendReminders(cycleId, now, { dueOnly?, acoId? })`, `getByToken(token)`,
`markSubmitted(invitationId)`.

Jobs: `invitations.activate` (safety net: PENDING invitations of cycles already
ASSESSMENT_OPEN, e.g. a sample locked after the assessment opened),
`invitations.reminders` (`deriveReminderSchedule` over the cycle's assessment
window and `reminders.assessment`; reminder k to every SENT / OPENED /
VERIFIED invitation with `remindersSent === k`, `once('invitation.reminder',
invitationId, k)`; when several are overdue only the latest goes out),
`invitations.expire` (live invitations past `expiresAt` → EXPIRED, or
`expiresAt` follows an extended window; an EXPIRED invitation comes back only
through a resend). Templates: `assessment-invitation`, `assessment-otp`,
`assessment-reminder`, `assessment-thank-you`.

## Onboarding

Self-registration of operators and airport organisations
(`src/modules/onboarding`; REQUIREMENTS §4–5, ARCHITECTURE §7 "Onboarding").
ACFI mints a link tied to one airport; the applicant fills the public form;
ACFI reviews it with the airport's current market-share total in view and
approves or rejects. Links store only the sha256 of the token
(`onboarding_links`); the raw token appears once, inside the `url` of the
create response (`${PUBLIC_WEB_URL}/register/<token>`). Every reviewer route
requires the PLATFORM scope (an operator or airport user gets 403 even when
granted the task). The public form is rate-limited in memory, 5 attempts per
IP per 15 minutes (`onboarding.ratelimit.ts`).

| Method | Path | Policy |
|---|---|---|
| POST, GET | `/onboarding/links` (`{ orgType: ACO\|AIRPORT, airportId, expiresInDays = 14, note? }`; list filters `status: OPEN\|USED\|EXPIRED, orgType, airportId`) | onboarding.links |
| DELETE | `/onboarding/links/:id` (revokes; 412 once used) | onboarding.links |
| GET | `/public/onboarding/:token` → `{ orgType, airport, expiresAt, used }` (404 unknown, 410 expired) | public |
| POST | `/public/onboarding/:token` (`organisation, admin, operations, marketSharePct?`) → `{ registrationId }`; 409 when already used | public |
| GET | `/registrations` (filters `status, orgType, airportId`) · GET `/registrations/:id` (adds `marketShare { entries, total, projectedTotal }`, null for AIRPORT) | onboarding.review |
| POST | `/registrations/:id/approve` (`{ code, marketSharePct?, note? }`) · POST `/registrations/:id/reject` (`{ note }`); 409 once reviewed | onboarding.review |

Approval is one transaction: organisation ACTIVE (`createdVia: LINK`) through
`createOrganisation`, admin user INVITED (`findOrCreateInvitedUser`),
`ACO_ADMIN` / `AIRPORT_ADMIN` membership, and for an operator the current
share (`setCurrentShare`, body value over the requested one). E-mails:
`registration-received` to the applicant plus a `generic` notice to every
ACFI member whose role has `onboarding.review`; `registration-approved`;
`registration-rejected`. Audit: `registration.submitted` (no actor; IP and
request id in `after.submittedFrom`), `registration.approved` (orgId = the new
organisation), `registration.rejected`, `onboarding.link.created/deleted`.
No events, no jobs.

## Sampling

Who an operator selects for a cycle (`src/modules/sampling`; REQUIREMENTS
§13–14, ARCHITECTURE §6 "sampling", §7 "Sampling"). ACO scope: an operator
acts for itself; PLATFORM names the operator with `acoId` (query on GETs,
body on POST/PUT; required). Another operator's id is 404. The pure rules in
`sampling/domain` decide everything: `eligibility` (ACTIVE customers whose
survey type matches, a BOTH customer in a BOTH cycle is two entries,
narrowed to the participant's survey types), `selection` (`{ add, remove }`
applied with per-item rejections: `UNKNOWN_CUSTOMER`, `INACTIVE_CUSTOMER`,
`WRONG_SURVEY_TYPE`, `ALREADY_SELECTED`, `NOT_SELECTED`,
`DUPLICATE_IN_REQUEST`, `CONFLICTING`) and `lockGate` (`evaluateLock`: lock
refused below `requiredSampleSize` unless fewer entries are eligible than
required and every one of them is selected — `shortfallRule: 'SELECT_ALL'`;
an empty selection never locks). `samples` keeps one row per
(cycle, operator, customer, surveyType); a de-selected entry stays as
`REMOVED` so it can be re-added.

| Method | Path | Policy |
|---|---|---|
| GET | `/sampling/cycles/:cycleId` (`?acoId=`) → selection state (below) | sampling.view |
| PUT | `/sampling/cycles/:cycleId/selection` (`{ add: [{ customerId, surveyType }], remove: [...] , acoId? }`) → `{ added, removed, rejected, state }` | sampling.manage |
| POST | `/sampling/cycles/:cycleId/select-all` (`{ acoId? }`; 412 unless eligible < required) → same shape | sampling.manage |
| POST | `/sampling/cycles/:cycleId/lock` (`{ acoId? }`) → selection state | sampling.lock |
| POST | `/sampling/cycles/:cycleId/unlock` (`{ acoId, reason }`; PLATFORM scope only, 403 otherwise) → selection state | sampling.unlock |
| GET | `/sampling/cycles/:cycleId/audit` [list] (`?acoId=`, plus the `/audit` filters) → the participant's `sample.*` entries | sampling.view |
| GET | `/customers/:id/participation` (`?acoId=`) → `{ customer, cycles: [{ cycleId, cycle, surveyType, state, addedAt, submitted }] }` | sampling.view |

Selection state: `{ cycle { id, code, name, type, status, samplingStart,
samplingEnd }, participant { cycleId, acoId, airportId, surveyTypes,
requiredSampleSize, sampling { status, selectedCount, lockedAt, lockedBy,
unlockedAt, unlockedBy, unlockReason } }, required, selectedCount,
eligibleCount, lockable, reason, shortfallRule, remaining, target, progress
("37 / 50"), progressPct, editable, selection: [{ id, customerId, customer,
surveyType, state, addedAt, addedBy }] }`. `lockable` is "pressing lock now
succeeds"; `reason` is the gate's `BELOW_MINIMUM | SELECT_ALL_REQUIRED |
NOTHING_SELECTED`, or `ALREADY_LOCKED` / `SAMPLING_CLOSED`. `editable` is true
while sampling is open (`SAMPLING_OPEN`, or `PUBLISHED` with the sampling
window already running) and the sample is not locked; a participant ACFI has
UNLOCKED may keep editing and re-lock after the window closed, until the
assessment closes. `participation.submitted` is read from `assessments` with
a lightweight query only when that module is registered in the process;
otherwise it is `null`.

Lock is one transaction: the gate is re-evaluated on the rows being locked,
samples → LOCKED, participant → LOCKED (`setParticipantSampling`),
`markLastSampled` on the customers, and `sample.locked` is emitted with the
session so the invitations listener commits or rolls back with it (a
listener error fails the lock and nothing persists). Unlock mirrors it
(samples → SELECTED, participant UNLOCKED, `sample.unlocked`). After commit:
audit `sample.locked` / `sample.unlocked` and e-mail `sample-locked` /
`sample-unlocked` to the operator's ACO_ADMIN users (organisation contact as
fallback). Selection changes audit `sample.selection.changed` (entity
`sample`, entityId = cycle id, orgId = operator). Exported:
`getSelection(cycleId, acoId)`, `lock(ctx, cycleId, acoId?)`,
`unlock(ctx, cycleId, acoId, reason)`. Events emitted: `sample.locked`,
`sample.unlocked`. No listeners, no jobs.

## Surveys

Reference data for the platform: one `surveys` document per version of each
type (`DOMESTIC`, `INTERNATIONAL`), with `categories`, `subcategories` and
`questions` referencing the version. A PUBLISHED version is immutable (every
write → 412 `PRECONDITION_FAILED`); editing means creating the next DRAFT
version (a deep copy of the latest) and publishing it, which RETIREs the
previously published one. Cycles pin versions by id, so a retired version
stays readable. Tasks: `surveys.view`, `surveys.manage`.

| Method | Path | Policy |
|---|---|---|
| GET | `/surveys` → `[{ code, name, publishedVersionId, draftVersionId, versions: [{ id, version, status, publishedAt, questionCount, … }] }]` | surveys.view |
| GET | `/surveys/:id` → `{ survey, categories: [{ …, subcategories: [{ …, questions[] }], questions[] }], issues[] }` | surveys.view |
| POST | `/surveys/:id/versions` (`{ name? }`; `:id` may be a type code to start v1) → the new DRAFT's tree; 409 when a draft exists | surveys.manage |
| POST | `/surveys/:id/publish` → PUBLISHED; 412 with `details.issues` when not ready | surveys.manage |
| GET | `/surveys/:id/preview?stakeholderType=FF\|CB` → the form (below) | surveys.view |
| PUT | `/surveys/:id/order` (`{ categories: [{ id, order, questions?, subcategories?: [{ id, order, questions? }] }] }`; orders only, PATCH moves) | surveys.manage |
| POST, PATCH, DELETE | `/surveys/:id/categories[/:catId]` (delete cascades) | surveys.manage |
| POST, PATCH, DELETE | `/surveys/:id/subcategories[/:subId]` (`categoryId` in the body; delete cascades) | surveys.manage |
| POST, PATCH, DELETE | `/surveys/:id/questions[/:qId]` (`categoryId`, `subcategoryId?`; code unique within the version) | surveys.manage |

`issues` on a draft tree is exactly what blocks publishing: at least one
category and one active question; category `weightPct` set on all categories
(totalling 100 ± 0.01) or on none; the same for active questions within a
category or subcategory. Exported: `getPublishedSurvey(type)`,
`getSurveyTree(surveyId)`, `getFormForStakeholder(surveyId, stakeholderType)`
→ `{ survey { id, code, name, version, status }, stakeholderType, scale,
questionCount, categories: [{ id, code, name, order, weightPct, questions,
subcategories: [{ id, code, name, order, questions }] }] }` with active
questions aimed at that type only (`{ id, categoryId, subcategoryId, code,
text, help, order, weightPct, mandatory, commentMode, followUp }`) and empty
groups dropped; `latestPublishedVersionIds()` → `{ DOMESTIC?, INTERNATIONAL? }`.
Audit: `survey.published`. No events, no jobs.

`npm run seed` (`src/seed/surveys.ts`, `seedSurveys()` — call it from tests
that need surveys) creates v1 PUBLISHED of each type from the vendored ACFI
bank (`src/modules/surveys/data/*.yaml`): the four heads as categories, 23
domestic / 27 international questions, mandatory, `REQUIRED_ON_LOW`, both
stakeholder types, and a placeholder follow-up (`What specifically went
wrong?` with generic options per head, marked for ACFI to edit). A type that
already has any version is left untouched.

## Cycles

Assessment cycles and who takes part in them (`src/modules/cycles`;
REQUIREMENTS §11–12, §19, §21, §24–25; ARCHITECTURE §5 `cycles` /
`cycle_participants`, §6 "cycles", §7 "Cycle clock"). The rules are the pure
functions in `cycles/domain` (`windows`: wall-clock ↔ UTC and ordering;
`derive`: windows from an initiation date and the reminder schedule;
`transitions`: the status table, `dueTransitions`, `checkManualTransition`,
`statusAfterPublish`; `participants`: survey types and required sample per
operator); this module applies them to storage. Windows are entered as
`YYYY-MM-DDTHH:mm` in the cycle's zone (`tz`, default `settings.defaults.tz`)
and stored as `{ wall, utc }`. Tasks: `cycles.view`, `cycles.manage`,
`cycles.publish`, `cycles.operate`, `monitoring.view`.

| Method | Path | Policy |
|---|---|---|
| GET | `/cycles` [list] (filters `status, type, airportId, acoId`; `q` over code, name) → summaries with `participants { airports, operators }` and `progress { locked, invited, completed }` over the participants in scope | cycles.view |
| POST | `/cycles` (`{ name, code, type, tz?, initiationDate?, sampling?, assessment?, minSampleSize, reminders?, participatingAirportIds, participatingAcoIds, surveyVersions? }`) → DRAFT; without windows they are derived from `initiationDate` + `settings.defaults` (`samplingDays`, `assessmentDays`, reminders) | cycles.manage |
| GET | `/cycles/current` (`?acoId=` required for PLATFORM / AIRPORT) → `[{ cycle, participant, nextDeadline }]` | cycles.view |
| GET | `/cycles/:id` → summary + `reminders, participatingAirportIds, participatingAcoIds, surveyVersions, marketShareFrozen, participantList[]` (participants in scope, joined with operator and airport) | cycles.view |
| PATCH | `/cycles/:id` — DRAFT: any field (windows rebuilt; `initiationDate` re-derives); afterwards only `sampling.end` / `assessment.end` extensions and `reminders` (400 otherwise; 412 once SCORED / ARCHIVED) | cycles.manage |
| POST | `/cycles/:id/publish` → guards (all 412): DRAFT; windows ordered and sampling not over; operators ACTIVE, at a participating airport and running a survey type of the cycle; every participating airport's current market shares total 100 (the message names the airport); a PUBLISHED survey version per type (`latestPublishedVersionIds()`, unless pinned). Then: shares copied to `market_shares` under `cycleId` (through organisations, audited `marketshare.updated`), `cycle_participants` created, status PUBLISHED or SAMPLING_OPEN (`statusAfterPublish`), `cycle-published` e-mail to every ACO_ADMIN of each operator, events `cycle.published` then `cycle.transitioned` | cycles.publish |
| POST | `/cycles/:id/transition` (`{ to, reason }`) → a manual edge of the table (re-opening a closed window needs its end in the future), audited with the reason, emitted with trigger `MANUAL` | cycles.operate |
| GET | `/cycles/:id/participants` [list] (filters `airportId, samplingStatus`; `q` over operator code / name) | cycles.view |
| GET | `/cycles/:id/monitoring` → `{ sampling { airports, operators, sampleRequired, sampleLocked, lockedOperators }, assessment { invited, started, completed, pending, completionRate }, byAirport: [{ airportId, iata, name, operators: [{ acoId, code, name, sampling { status, selectedCount, required }, invited, started, completed }] }] }` | monitoring.view |
| POST | `/cycles/:id/reminders/send` (`{ kind: SAMPLING\|ASSESSMENT, acoId? }`) → `{ kind, sent, recipients }`; SAMPLING mails the unlocked participants now (412 unless SAMPLING_OPEN); ASSESSMENT is forwarded to the sender invitations registers with `registerAssessmentReminderSender` (412 until then) | cycles.operate |

Visibility: PLATFORM everything; an ACO the non-DRAFT cycles it is listed in
and only its own participant; an AIRPORT organisation the cycles its airport
is in and the participants at it; anything else is 404.

A participant (`cycle_participants`, one per cycle + operator) is
`{ cycleId, acoId, airportId, surveyTypes: [DOMESTIC|INTERNATIONAL],
requiredSampleSize, sampling { status: NOT_STARTED|IN_PROGRESS|LOCKED|UNLOCKED,
selectedCount, lockedAt, lockedBy, unlockedAt, unlockedBy, unlockReason },
stats { invited, started, completed }, selfAssessment { DOMESTIC, INTERNATIONAL:
NOT_STARTED|DRAFT|SUBMITTED, null for a type the operator does not run },
reminders { sent, lastAt } }`, on the wire with `operator { id, code, name }`
and `airport { id, iata, name }`. `GET /cycles/current` returns, for every
cycle the operator is in with status PUBLISHED … ASSESSMENT_CLOSED, oldest
sampling start first, `{ cycle: <summary>, participant, nextDeadline: { kind:
SAMPLING_OPENS|SAMPLING_CLOSES|ASSESSMENT_OPENS|ASSESSMENT_CLOSES, at } | null }`
(SAMPLING_CLOSES becomes ASSESSMENT_OPENS once the sample is locked).

Exported: `getCycle(ctx, id)`, `getParticipant(cycleId, acoId)`,
`listParticipants(cycleId)`, `setParticipantSampling(cycleId, acoId, patch,
session?)`, `bumpParticipantStats(cycleId, acoId, field, delta, session?)`,
`setSelfAssessmentStatus(cycleId, acoId, surveyType, status, session?)`,
`currentCyclesForOperator(acoId)`, `isMarketShareFrozen(cycleId)` (registered
into organisations' `registerMarketShareFreezeCheck` at boot: frozen from
ASSESSMENT_OPEN on) and `transition(ctx, cycleId, to, reason, { trigger?,
now? })` (trigger defaults to CLOCK under a system context, MANUAL under a
request; CLOCK takes AUTO edges only). Events emitted: `cycle.published`,
`cycle.transitioned` (after the status write, without a session). Listeners:
`assessment.submitted` → `stats.completed` (CUSTOMER) or
`selfAssessment.<type> = SUBMITTED` (SELF); `invitation.sent` →
`stats.invited`; `scoring.completed` (not provisional) → SCORED;
`cycle.transitioned` to SAMPLING_OPEN → `cycle-published` ("sampling is open")
to the admins of the operators not yet locked, to SAMPLING_CLOSED →
`sampling-closed` to those still unlocked. Audit:
`cycle.created/updated/published/transitioned`.

Jobs (`src/jobs/cycles.jobs.ts`): `cycles.transitions` — every tick, each
cycle in PUBLISHED … ASSESSMENT_CLOSED takes every step `dueTransitions`
makes due, in order, `once()` per cycle + target status + window instant (an
extended window is a new slot), trigger CLOCK; ASSESSMENT_CLOSED → SCORED is
left to `scoring.completed`. `cycles.samplingReminders` — for every
SAMPLING_OPEN cycle, each participant not LOCKED receives reminder k of
`deriveReminderSchedule(sampling, reminders.sampling)` (09:00 in `tz`, none
before `publishedAt`) once it is due, `once()` per participant + index; after
downtime only the latest overdue reminder goes out.

## Scoring

Scores, airport roll-ups and rankings (`src/modules/scoring`; REQUIREMENTS
§20–23, ARCHITECTURE §5 `scores` / `airport_scores`, §6 "scoring and
reports", §7 "Scoring"). The arithmetic is the tested engine in
`scoring/engine` (`scoreAssessments`, `feedbackDistribution`,
`rankOperators`, `rollupAirport`, `withPrevious`); the service loads the
documents, persists and announces. A run (`runCycle(cycleId, { provisional })`)
takes, per survey type the cycle pinned, every participant running it: the
pinned survey tree, its SUBMITTED assessments (CUSTOMER and SELF) and
`settings.scoring` → one row per level and ref (OVERALL, category,
subcategory, question; inactive questions skipped), NA excluded, a level
`suppressed` below `minResponses`, the FF / CB split hidden on its own below
it, SELF averaged apart. `refId` is the node's stable CODE, so `previous`
/ `delta` (from the most recent SCORED cycle that ran the type, by assessment
end) survive a new survey version. Operators are dense-ranked on the OVERALL
customer mean (`rank` / `rankOf` on the OVERALL row). Each airport is then
rolled up per level and ref over its operators running the type, weighted by
the cycle's market-share snapshot (`market_shares` rows with the `cycleId`;
no snapshot → equal weights, `marketShareApplied: false`), the figure `null`
when the operators with a score cover under half the airport
(`coveredSharePct`), and airports are ranked per level and ref. Rows are
upserted per operator / airport and survey type in one transaction each, so
a re-run replaces figures in place and is idempotent; every row carries
`provisional` and `computedAt`. A cycle is scorable from ASSESSMENT_OPEN on
(412 before). Audit: `scoring.run` (entity `cycle`; the actor, or the system
reason). Event emitted: `scoring.completed { cycleId, provisional }` — cycles
marks the cycle SCORED when not provisional.

| Method | Path | Policy |
|---|---|---|
| POST | `/scoring/cycles/:cycleId/run` (`{ provisional? }`) → `{ cycleId, provisional, computedAt, surveyTypes, operators, airports, rows, airportRows }`; provisional while the assessment is open, final afterwards unless asked; 403 without `cycles.operate` or outside a PLATFORM organisation, 404 for a cycle out of scope | session + `cycles.operate` (the registry only accepts a module's own tasks, so the service asserts it) |

Exported to reports: `getScores(cycleId, acoId, surveyType)` → `{ cycleId,
acoId, surveyType, surveyId, provisional, computedAt, rows: [{ level, refId,
customer { mean, n, naCount, byType { FF, CB } }, self { mean, n },
suppressed?, rank?, rankOf?, previous? { cycleId, mean }, delta? }] (tree
order), distribution: [{ rating, label, count, pct }], counts { customer,
self, FF, CB } }` (empty rows, zero counts and `computedAt: null` when not
scored); `getAirportScores(cycleId, airportId)` → `[{ cycleId, airportId,
surveyType, level, refId, mean, marketShareApplied, coveredSharePct,
operators: [{ acoId, mean, sharePct, suppressed }], rank, rankOf,
provisional, computedAt }]`; `nationalTable(cycleId, surveyType)` → `[{
airportId, iata, name, mean, rank, rankOf, marketShareApplied,
coveredSharePct, provisional, computedAt }]` best first — airport figures
only, never an operator's, so an ACO may see it as-is. Listener:
`cycle.transitioned` to ASSESSMENT_CLOSED → `runCycle(cycleId, { provisional:
false })` (the transition is emitted after its write, so the run owns its
transactions; a failure surfaces as the transition's error with the cycle
left ASSESSMENT_CLOSED, which `scoring.finalise` picks up).

Jobs (`src/jobs/scoring.jobs.ts`): `scoring.nightly` — every ASSESSMENT_OPEN
cycle gets a provisional run on the first tick at or after 01:00 in the
cycle's `tz`, `once()` per cycle + local day (a catch-up tick later the same
day finds the slot done). `scoring.finalise` — safety net for the final run,
which is the listener's: the cycle clock leaves the SCORING step to scoring
and does not retry it, so a cycle still ASSESSMENT_CLOSED fifteen minutes
after its last status change gets the final run redone, `once()` per cycle +
assessment end (an extended, re-closed window is a new slot); idempotent, so
after a lost SCORED transition it only re-emits `scoring.completed`.
`POST /scoring/cycles/:cycleId/run` does the same by hand.

## Reports

Read-only composition over scoring, cycles, assessments, surveys,
organisations and airports (`src/modules/reports`; REQUIREMENTS §23–25,
ARCHITECTURE §6 "scoring and reports", §7 "Scoring" and "Confidentiality").
Every figure on the wire is 2 dp or `null`. Without `cycleId` a report is
about the latest SCORED cycle the subject took part in, else the current live
one with `provisional: true` (figures from the nightly / manual provisional
run); without `surveyType` it is the subject's first survey type in that
cycle. A cycle the subject did not take part in, a survey type it did not
run, and a cross-tenant subject are all 404. Tasks: `reports.operator`,
`reports.airport`, `reports.national`.

| Method | Path | Policy |
|---|---|---|
| GET | `/reports/operator/:acoId` (`?cycleId=&surveyType=`) → `{ cycle, surveyType, provisional, operator { id, code, name, airport }, overall { customer { mean, n }, self { mean }, rank, rankOf, suppressed? }, comparison { current, previous }, feedbackDistribution: [{ rating, label, count, pct }], categories: [{ id, code, name, customer, self, previous, delta, suppressed?, subcategories[] }], byStakeholder { FF, CB }, assessorStats { total, completed, inProgress, yetToStart }, nationalTable: [{ airportIata, airportName, rating, rank }] }` | reports.operator |
| GET | `/reports/operator/:acoId/questions` (`?cycleId=&surveyType=`) → `{ cycle, surveyType, provisional, operator, questions: [{ id, code, text, category, subcategory, customer { mean, n, naCount }, self, previous, delta, suppressed?, comments }] }` (active questions in survey order) | reports.operator |
| GET | `/reports/airport/:airportId` (`?cycleId=&surveyType=`) → `{ cycle, surveyType, provisional, airport, overall { mean, coveredSharePct, marketShareApplied, rank, rankOf }, operators?: [{ acoId, code, name, mean, sharePct, suppressed }], categories: [{ id, code, name, mean, coveredSharePct, marketShareApplied }] }`; `operators` for PLATFORM and AIRPORT callers only | reports.airport |
| GET | `/reports/national` (`?cycleId=&surveyType=`) → `{ cycle, surveyType, provisional, airports: [{ …airport, rating, rank, rankOf, coveredSharePct, marketShareApplied }], operators: [{ acoId, code, name, airport, rating, n, rank, rankOf, suppressed? }], categories: [{ id, code, name, mean, n }], participation { airports, operators, sampleLocked, invited, started, completed, pending, completionRate } }` | reports.national |
| GET | `/reports/comparison` (`?acoId=&cycleIds=a,b[,…]&surveyType=`, up to 6 cycles) → `{ operator, surveyType, cycles: [{ …cycle, provisional }], overall: [{ cycleId, customer, self, rank, rankOf }], categories, subcategories, questions: [{ code, name, parentCode, values: [{ cycleId, customer, self, suppressed? }] }] }`; nodes matched on code across survey versions | reports.operator |
| GET | `/reports/export` (`?scope=operator\|airport\|national&cycleId=&surveyType=&acoId=&airportId=&format=csv`) → CSV attachment; the task of the chosen scope is required (403), `acoId` / `airportId` for that scope (400) | session |

Who sees what: PLATFORM any operator or airport; an ACO only itself and the
airport it operates at (no `operators` table there); an AIRPORT organisation
its own airport and the operators at it. The national table inside the
operator report carries airport ratings and ranks only, never another
operator's figures. `assessorStats` comes from the participant's
`stats { invited, started, completed }` (`inProgress = begun − completed`,
`yetToStart = invited − begun`, with `begun = max(started, completed)`);
`comments` counts the SUBMITTED CUSTOMER answers of the cycle that carry a
comment (`listSubmitted`). Everything else — rows keyed by the survey node's
code, the feedback distribution, ranks, airport roll-ups and the national
table — is read from the scoring module's `getScores`, `getAirportScores` and
`nationalTable`, and the survey tree the cycle pinned supplies names, ids and
order. The lower contracts are consumed in `reports.sources.ts` only, which is
also the seam `test/reports.test.ts` replaces; `test/reports.flow.test.ts`
drives the real surveys, cycles and assessments modules and replaces scoring
alone. No audit (reads only), no events, no jobs.
