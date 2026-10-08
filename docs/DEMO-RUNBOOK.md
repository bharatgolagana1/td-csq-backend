# Demo runbook — 9 Oct 2026

**Live site:** https://dev.csq.aero → *Sign in* → https://dev.csq.aero/app (API at
https://dev.csq.aero/api/v1). The demo data is loaded there; nothing needs to run
on the laptop. The local setup below is the fallback.

Everything runs on the laptop: MongoDB (Homebrew service), the API on 4000,
the web app on 5173. Identity is the hosted Keycloak realm `csq` on
https://auth.tinydata.in/ — it must exist before anyone can sign in (see
`deploy/keycloak/README.md`; `node deploy/keycloak/provision.mjs` creates it
from `realm/csq-realm.json` and the demo users from a JSON file).

## Before the demo (once)

```sh
# backend
brew services start mongodb/brew/mongodb-community     # rs0 on 27017
cd td-csq-backend && npm install
cp .env.example .env   # PORT=4000, MONGO_URI=mongodb://127.0.0.1:27017/csq?replicaSet=rs0,
                       # KEYCLOAK_* for realm csq, PUBLIC_WEB_URL=http://localhost:5173,
                       # DEMO_REVEAL_OTP=true (the OTP shows on the page; no SMTP needed)
npm run seed
npm run seed:demo -- --super-admin email=<your Keycloak e-mail> name="<name>"   # ~5 min
npm run dev

# web
cd td-csq-frontend && npm install
# .env: VITE_API_BASE_URL=http://localhost:4000/api/v1, VITE_KEYCLOAK_* for realm csq
npm run dev
```

Sign in at http://localhost:5173 with the Keycloak user whose e-mail you
passed to `seed:demo`; the app links it to the ACFI super admin on first
sign-in. Operator admins are the `*@example.in` users the seed printed —
create one of them in Keycloak too (same e-mail) to show the operator side.

## Storyline (requirements §27)

1. **Overview** — the live cycle "CSQ 2026 H2" funnel, operators still
   unlocked, two registrations waiting, one airport over 100 %.
2. **Onboarding → Requests** — open a request, show the projected share
   total, approve one; **Operators** shows it active with its invited admin.
3. **Surveys** — Domestic (23) and International (27) across the four heads;
   open a question, show the follow-up that appears on Fair/Poor.
4. **Market share** — pick an airport, show the 100 % guard.
5. **Cycles → CSQ 2026 H2** — windows, participants with 37 / 50 counters,
   Monitoring tiles; **Cycles → New cycle** — derive windows from one
   initiation date with the calendar.
6. **Switch to an operator** (org switcher or a second browser) —
   **Customers** (import a CSV from the template), **Sampling**: select to
   reach 50, **Lock**. The invitations tab shows them pending.
7. **Back as ACFI** — Cycle detail → *Transition…* → `ASSESSMENT_OPEN`
   with a reason (this is what the clock does at midnight). **Notifications**
   now lists `assessment-invitation` e-mails; open one and copy its link.
8. **On a phone (or a phone-width window)** — open the link: landing →
   *Send me a code* → the code is shown on the page in demo mode → the four
   heads → review → submit. Reopen the link: "this assessment is in".
9. **Operator → Dashboard** — the scored cycle "CSQ 2026 H1": rating,
   rank of 12, self vs customer, feedback band, category deltas, all-India
   table; **Questions** tab; **History**.
10. **ACFI → Reports** — airport (market-share weighted), national, comparison,
    export. **Audit** shows every step just taken. **Users & roles → Role → Task
    matrix** — change a grant and show it take effect on the next request.

## Fallbacks

- Keycloak not reachable: http://localhost:5173/dev/design/shell renders every
  screen with mocked data (role switcher top-right) — say so on screen.
- Scoring for the live cycle: *Transition…* → `ASSESSMENT_CLOSED` runs the
  final scoring; the demo data's scored cycles need nothing.
- Reset the demo data: `npm run seed:demo -- --reset` then `seed:demo` again.
