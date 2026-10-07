# CSQ — build plan for the 9 Oct 2026 demo

Written 7 Oct 2026, after reviewing both repos, the 2017 product documents and
the ACFI pitch deck. The other MacBook's work never reached GitHub; this plan
replaces it and lives in git.

## What the demo must show (storyline, requirements §27)

1. **Super Admin (ACFI)** signs in → masters: Airports, Operators (ACO/CTO),
   Question bank (23 parameters, four heads), Market share per airport, Role →
   Task matrix → creates **Assessment Cycle** (type, sampling + assessment
   windows, minimum sample, reminders, participating airports/ACOs) → publishes.
2. **ACO Admin** signs in → sees the cycle strip ("Sampling closes in N days ·
   37 / 50 selected") → FF/CB directory (add, bulk import) → selects sample →
   **Lock** (blocked below minimum; audit trail).
3. **System** activates the assessment (midnight on start date; a "Send
   invitations now" action for the demo) → every sampled FF/CB gets a secure
   link.
4. **FF/CB** opens the link on a phone → OTP → questionnaire (four heads,
   Excellent/Very Good/Good/Fair/Poor/NA, comments, progress, save draft) →
   submit.
5. **Scores** → ACO dashboard (ACFI deck slide 8: rating, rank of 14, self vs
   customer, feedback distribution, category deltas, all-India table) → Super
   Admin monitoring (sample required/locked, invites, started, completed) →
   airport roll-up with market-share weighting.

## Decisions

- **Identity:** the shared Keycloak at `https://auth.tinydata.in/`, realm
  `csq`, clients `csq-frontend` (public, PKCE, audience mapper → `csq-api`)
  and `csq-api`. Keycloak supplies identity only (`sub`, email, name).
- **Permissions:** Role → Task matrix, stored in `role_definitions`
  (tasks = capability codes declared by the modules). Super Admin edits it in
  a matrix UI; changes re-project onto live memberships. Frontend gates nav
  and routes by task codes from `/v1/orgs/memberships/mine`.
- **Participants (FF/CB) have no Keycloak account.** A signed single-use
  invitation link + 6-digit OTP (email; WhatsApp/SMS later) yields a
  short-lived participant session for the public `/assess` form.
- **Scale and instrument:** ACFI deck — 23 parameters, four heads
  (Infrastructure/Facilities, Security/Safety, Processes, Trade
  Facilitation), five labels + NA, NA excluded from the mean, SELF never in
  the published score, results confidential per operator.
- **Vocabulary:** Operator = ACO (synonym CTO in older docs), Customer = FF or
  CB, Sample / Lock, Assessment Cycle, Parameter, Head (category).
- **Scope held for after the demo:** WhatsApp/SMS channels, airport-user
  dashboards, third-party assessor firms, unlock-request workflow beyond an
  audited Super Admin action.

## Backend work

| # | Piece | Owner / files |
|---|-------|---------------|
| B1 | Keycloak realm export + env (`deploy/keycloak/realm`) | blocked on admin access |
| B2 | Role grants + `GET/PUT /v1/orgs/role-matrix` + seed that doesn't clobber edits | orgs module |
| B3 | Invitation flow: `invites` module, PUBLIC `/v1/invite/:token` (status, otp, verify, form, answers, submit), participant session, sample lock → assignments + invitations, "activate now", reminders → notify | invites, assessments bridge, kernel/auth participant principal, kernel/notify |
| B4 | Coupling: cycle publish → per-ACO sampling policy; lock → participation state; submit → progress; freeze → rollups; Super Admin monitoring endpoint | cycles, sampling, scoring |
| B5 | Scoring fixes: coverage averaged per assessor, rounding, market-share roll-up at airport level | core/scoring, scoring module |
| B6 | Demo seed: ACFI org + super admin, 14 Phase-I airports with illustrative operators, one scored previous cycle + one live cycle | `pnpm seed:demo` |

## Frontend work

| # | Piece |
|---|-------|
| F1 | New shell: left rail driven by tasks, cycle context strip, org switcher, user menu; design tokens; legacy 2024 screens removed; Role → Task matrix screen |
| F2 | Wire to the API: dashboard, admin masters (operators + approvals, airports, question bank, market share), cycle builder, sampling + lock gate, history, Super Admin monitoring |
| F3 | Public assessor form on the invitation flow: link → OTP → stepper by head → review → submit, mobile first |

## Design brief ("next level")

Light working surface, dense but calm. Archivo for headings (continuity with
the landing site), Lato for body, IBM Plex Mono for every number. The CSQ
rating ramp is the only colour that carries meaning and is never a traffic
light. Every page opens with context: which cycle, which operator, what closes
when. Status is a pill, never a colour alone. Forms live in drawers, lists in
tables with sticky headers and real empty states. Nothing illustrative is
shown without an "Illustrative · sample data" chip. The assessor form is
designed for a phone in a cargo yard: one head per step, large tap targets,
progress always visible, autosave.

## Carried over from the 2017–2021 product (what ACFI's users already know)

- Cycle setup from one **initiation date**: sampling window (10 d), assessment
  window (30 d), reminders (10, every 2 d) derived and editable.
- Sampling banner: "Minimum N customers are required. If fewer are
  available, select all." Mail option to resend login / reminder per customer.
- Customer e-mail offered a passwordless token link; login gated to the
  assessment start time. Our link + OTP is the modern form of that.
- Form: all parameters mandatory, Submit disabled until complete, progress
  "14 of 23 · 61 % answered", draft autosave, sub-questions only on
  Fair / Poor, one comment per question, read-only after submit.
- Operator dashboard carried **assessor stats** (total / completed / in
  progress / yet to start, click-through to the list) next to the ratings.
- History grid: cycle, assessor kind (Self / Customer), customer type
  (FF / CB), name, e-mail, submitted date, score to 1 dp; row opens the
  read-only return.
- Admin "Requests" screen for onboarding approval with market share entry;
  market shares at an airport must total 100.

## Order

Evening 7 Oct: B2, B3, F1 in parallel; B1 as soon as Keycloak access arrives.
8 Oct: B4, B5, B6, F2, F3. 9 Oct morning: seed, rehearse the storyline twice
on the demo laptop, offline from nothing but Keycloak.
