# @csq/api

The kernel, plus the settings module built on it as the worked example. Six more
modules are being built against this contract in parallel, so read the module
contract below before adding one.

## Running it

```sh
docker compose up -d mongo            # replica set rs0 on 27017
cp apps/api/.env.example apps/api/.env
pnpm --filter @csq/api dev
```

Every variable in `.env.example` is required. The process prints the ones that
are missing or malformed and exits non-zero rather than starting with a default,
because a default that looks like it works is how a staging build ends up
pointed at a production database.

```sh
cp apps/api/.env.example apps/api/.env.test   # MONGO_URI at a throwaway database
pnpm --filter @csq/api test
```

The suite talks to a real MongoDB. There is no in-memory substitute, because the
two things most worth testing here, the tenancy plugin and the unique indexes
behind the settings lists, only exist in the server.

## What the kernel guarantees

**Configuration** `src/config/env.ts` is the only file in the codebase that
reads `process.env`. Everything else receives configuration as an argument,
which is what makes the app factory testable and stops a module quietly reaching
for a variable nobody validated.

**Identity** `src/kernel/auth.ts` verifies the bearer token against the realm's
published keys with the issuer pinned, the audience checked, RS256 the only
accepted algorithm and 60 seconds of clock tolerance. The token says who the
caller is; the `users` collection says what they may do. The prototype called
`jwt.decode`, which checks no signature at all, so every route was forgeable by
anyone who could base64 a JSON object.

**Tenancy** `src/kernel/tenancy.ts` injects the organisation filter on every
query path Mongoose exposes, including `aggregate`, `insertMany` and
`bulkWrite`, and on the document `validate` and `save` hooks, because query
middleware does not fire on `.save()` and `.save()` is the path that sets
ownership. Touching a tenant collection with no request context throws. So does
`estimatedDocumentCount`, which cannot be filtered and would therefore report
every tenant's row count.

**Cross-tenant reads are 404** A request for another organisation's document is
answered byte-identically to one that never existed. 403 means right
organisation, wrong capability. A 403 on a cross-tenant id turns every list
endpoint into an enumeration oracle for competitor identifiers.

**Route policy** `src/kernel/router.ts` refuses to build the router if any route
lacks a policy, so an unprotected endpoint cannot reach production. The prototype
shipped a role guard that was imported and applied to nothing.

## The module contract

A module is one directory under `src/modules/`, exporting one `ApiModule`, added
to the array in `src/modules/index.ts`. Nothing else in the kernel changes.

```ts
export const cyclesModule = defineModule({
  name: 'cycles',
  basePath: '/v1/cycles',
  capabilities: ['cycles:read', 'cycles:write'],   // every capability you invent
  routes: [
    {
      method: 'get',
      path: '/',
      summary: 'List cycles',
      policy: { requiredCapability: 'cycles:read', tenancy: 'ORG' },
      handler: (req) => listCycles(parseQuery(CycleQuery, req)),
    },
  ],
});
```

Rules the boot check enforces, with the process exiting rather than starting:

- every route declares `policy`
- a route may only require a capability its own module declares, which catches
  the typo that would otherwise be a permanently ungrantable route
- a `PUBLIC` route cannot require a capability
- a `PLATFORM` route must require one
- an authenticated route with no capability must carry a written `openReason`
- two modules cannot claim the same method and path

Tenancy classes:

| class      | principal | organisation | notes                                        |
| ---------- | --------- | ------------ | -------------------------------------------- |
| `PUBLIC`   | no        | no           | health, webhooks that carry their own signature |
| `SELF`     | yes       | no           | profile, organisation switcher                |
| `ORG`      | yes       | yes          | almost everything. Tenant filters apply       |
| `PLATFORM` | yes       | system scope | cross-organisation staff work, reason logged  |

Which organisation an `ORG` request acts in comes from the `x-csq-organisation`
header, or is implied when the caller has exactly one active membership. A
header naming an organisation the caller does not belong to is a 404.

### Data access

Declare collections with `defineTenantModel`, never `new Schema` plus
`mongoose.model`, so the tenancy plugin cannot be left off:

```ts
export const CycleModel = defineTenantModel<CycleDoc>({
  name: 'Cycle',
  definition: { state: { type: String, required: true } },
  configure: (schema) => schema.index({ orgId: 1, state: 1 }),
});
```

Then wrap it in a `TenantRepo`. Passing an organisation id is a compile error,
not a convention:

```ts
const cycles = new TenantRepo<CycleDoc>(CycleModel);
await cycles.find({ state: 'OPEN' });          // fine
await cycles.find({ orgId: someOrgId });       // does not compile
```

Service functions take no organisation argument at all. There is nothing to get
wrong and no call site that can be persuaded to pass someone else's.

### Errors

Throw `fail(code, message)` from `src/kernel/errors.ts`, or one of `notFound`,
`forbidden`, `conflict`, `unauthenticated`. The status code for each member of
the error union lives in one table so the same failure cannot be a 409 in one
module and a 422 in the next. Anything unrecognised is logged in full and
answered with a bare `INTERNAL`: a stack trace in a response body is a free map
of the codebase for whoever is probing it.

### Workers

Background work has no request, so it has no scope. Enter one explicitly:

```ts
await runSystem({ reason: 'outbox drain for cycle rollover', log }, () => drain());
```

The reason is a required argument and is logged before the work starts, so an
audit of every tenancy bypass is a log query rather than a code review.

## The settings module

Shaped after the settings area in Legal Genius: a hub of many small,
independently writable areas, each gated by its own permission, plus curated
lists and per person preferences. Legal Genius builds that hub in the frontend
from an array of areas and hides the ones the signed in user has no permission
for. Here the array lives in `settings.areas.ts` and the server does the
hiding, so adding an area is one entry in that file and needs no frontend
release, and the menu never describes what the caller may not have.

### The registry

Each area declares its title, description, icon token, frontend route, the
capability that gates reading and writing, its sections as zod schemas, and its
defaults. Defaults live in the registry rather than the database, so an area
nobody has saved yet reads as a complete, valid payload, and an area that gains
a field reads as that field's default everywhere instead of as a hole the
frontend has to guess at. The defaults are parsed against their own schemas at
import, so a default that does not satisfy its schema stops the process at boot.

### Scopes

| scope    | one document per | served at                     |
| -------- | ---------------- | ----------------------------- |
| `GLOBAL` | the platform     | `/v1/settings/platform/:key`  |
| `ORG`    | organisation     | `/v1/settings/org/:key`       |
| `SELF`   | person           | `/v1/settings/me/:key`        |

Areas: `organisation`, `users-and-roles` and `notifications` for an
organisation; `my-account`, `navigation` and `display` for a person;
`question-bank`, `weightage` and `approval-mode` for the platform. The curated
lists keep their own endpoints, because a list is a collection rather than a
settings payload, and appear in the catalogue as a link.

| method   | path                               | capability             |
| -------- | ---------------------------------- | ---------------------- |
| `GET`    | `/v1/settings`                     | own menu               |
| `GET`    | `/v1/settings/catalogue`           | own menu               |
| `GET`    | `/v1/settings/org/:key`            | `settings:read` + area |
| `PATCH`  | `/v1/settings/org/:key`            | `settings:write` + area |
| `GET`    | `/v1/settings/org/:key/audit`      | `settings:read` + area |
| `GET`    | `/v1/settings/me/:key`             | own row                |
| `PATCH`  | `/v1/settings/me/:key`             | own row                |
| `GET`    | `/v1/settings/me/:key/audit`       | own row                |
| `GET`    | `/v1/settings/platform/:key`       | `settings.platform:read` |
| `PATCH`  | `/v1/settings/platform/:key`       | `settings.platform:write` |
| `GET`    | `/v1/settings/platform/:key/audit` | `settings.platform:read` |
| `GET`    | `/v1/settings/lists`               | `settings:read`        |
| `GET`    | `/v1/settings/lists/:kind`         | `settings:read`        |
| `POST`   | `/v1/settings/lists/:kind`         | `settings.lists:write` |
| `PUT`    | `/v1/settings/lists/:kind/order`   | `settings.lists:write` |
| `PATCH`  | `/v1/settings/lists/:kind/:itemId` | `settings.lists:write` |
| `DELETE` | `/v1/settings/lists/:kind/:itemId` | `settings.lists:write` |

Decisions worth knowing:

**The route policy states the floor, the area states the rest.** A path that
carries its area in a parameter cannot name that area's capability in its
policy, so the policy requires `settings:read` or `settings:write`, may you open
settings at all, and the area's own capability is enforced in the service where
the area is known. A service call that never went through a route is checked
the same way.

**A patch names sections and fields, never the whole document.** Two
administrators on two tabs of the same screen is normal, and a whole document
write silently discards whichever of them saved first. A patch may state the
`expectedRevision` it was based on; a stale one is a 409. Each area has its own
revision counter, so saving notifications does not make somebody's open
organisation tab look stale. An unknown section or field is rejected rather than
ignored, because a silently dropped field is a bug report from a user who
watched their setting not save.

**Every patch is audited with the actor, the value before and the value after.**
Organisation audit rows are tenant scoped like everything else; personal and
platform rows live outside tenancy with the subject on the row. The audit is
written after the value, because a row for a change that did not happen is worse
than one that arrives a moment later. Without a transaction the pair is not
atomic, and a replica set alone would not make it so across two collections
unless the write is wrapped in a session.

**The platform areas are SELF routes, not PLATFORM ones.** A `PLATFORM` route
enters a system scope, and a system scope carries no principal and passes the
kernel's capability guard unconditionally, so the actor behind a change to a
platform wide setting would be unknown and the guard would gate nothing. These
routes keep the principal, and the service checks `settings.platform` against
that person's active memberships, which is a real gate and an attributable audit
row. The collection itself refuses any access from inside an organisation scope.

**Personal settings follow the person, not the membership.** The language
somebody reads in does not change because they switched terminals, so the row is
keyed by user alone and no request shape reaches anybody else's.

**Lists are archived, not deleted,** because historical records point at them,
and the uniqueness index is partial on the live rows so archiving frees the
label. **Reordering takes the complete live set,** because a partial order
cannot be applied without inventing positions for the entries the client did not
mention, and inventing them is how two open tabs end up disagreeing.

### A note on the test suite

The whole module is tested in one file on purpose. Vitest gives each test file
its own module graph, but a mongoose model is registered once per process, so a
second file importing the same models gets the first file's compiled middleware,
and with it the first file's `AsyncLocalStorage`. Every tenant scoped query in
that second file then fails with "No request context". Splitting a module's
tests across files needs either `isolate: false` or models that no two files
share.
