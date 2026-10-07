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
