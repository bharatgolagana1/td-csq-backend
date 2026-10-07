# CSQ — build plan

Rewritten 7 Oct 2026 after the decision to rebuild both repositories from
scratch (the September 2026 code is archived on `archive/2026-09-rewrite`).
Scope is the full product in `docs/REQUIREMENTS.md`, built to
`docs/ARCHITECTURE.md` (backend) and `../td-csq-frontend/docs/ARCHITECTURE.md`
(web). The 9 Oct demo shows whatever is complete; quality is not traded for
the date.

## Waves

**Wave 0 — foundations** (in progress)
- Backend: core (env, errors, http, db, auth, RBAC, link sessions, audit,
  scheduler), identity (users, roles, tasks, Role → Task matrix,
  memberships, /me), organisations + market share, airports (+ seed),
  settings, notifications (SMTP/LOG + log), health, test harness, seed.
- Web: design tokens, primitives, icons, charts, shell, auth/session,
  router with guarded placeholders, Users & roles + Role → Task matrix,
  dev design gallery at `/dev/design`.

**Wave 1 — features** (parallel, disjoint folders)
- Backend: `onboarding` · `surveys` · `cycles` (+ scheduler jobs) ·
  `customers` · `sampling` · `invitations` + public participant flow ·
  `assessments` (customer + self) · `scoring` · `reports`.
- Web: onboarding (links, requests, approval) · surveys editor · cycles
  (list, builder, detail, monitoring) · operators + airports + market share ·
  customers + bulk import · sampling + lock · self-assessment · history ·
  operator dashboard · airport/national reports · notifications + audit +
  settings · public register and assess flows.

**Wave 2 — integration**
- End-to-end flow tests (onboard → cycle → sample → lock → activate →
  OTP → submit → score → dashboard), demo dataset (`seed:demo`), Playwright
  smoke on the public flows, performance pass on lists, deployment.

## Demo storyline (requirements §27)

Super Admin: airports, operators, survey, market share, Role → Task matrix,
create and publish a cycle → ACO Admin: customers, bulk import, select 50,
lock → System: activate, invitations → FF/CB on a phone: link, OTP,
questionnaire, submit → Scores: operator dashboard, Super Admin
monitoring, airport roll-up with market-share weighting.

## Environment for the demo

- Keycloak: realm `csq` on `https://auth.tinydata.in/` from
  `deploy/keycloak/realm/csq-realm.json` (needs admin access — pending).
- MongoDB Community 9 as a Homebrew service, replica set `rs0` on 27017.
- E-mail: SMTP_URL if available, otherwise the notifications log shows every
  message (with `DEMO_REVEAL_OTP=true` the OTP is returned to the page).
