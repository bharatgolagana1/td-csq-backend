# Keycloak for CSQ

Identity only. Keycloak says *who* the caller is (`sub`, email, name); the
CSQ database says what they may do, through the Role → Task matrix. No
realm or client roles are used for authorisation.

Keycloak is hosted at `https://auth.tinydata.in/` and is not part of the
compose stack. The e-mail is the join key: a CSQ user (created by `npm run
seed -- --super-admin …`, by `seed:demo`, or by an administrator in the app)
is INVITED until a Keycloak account with the same e-mail signs in once; that
first request stores the Keycloak `sub` and activates the account.

## Realm

`realm/csq-realm.json` creates realm `csq` with two clients:

| client         | kind         | purpose                                                     |
| -------------- | ------------ | ----------------------------------------------------------- |
| `csq-frontend` | public, PKCE | the web app signs in with it; an audience mapper adds `aud=csq-api` to every access token |
| `csq-api`      | bearer-only  | the audience the API checks (`KEYCLOAK_AUDIENCE=csq-api`)    |

No users are in the export: passwords never belong in git.

## provision.mjs

Node ≥ 22, no dependencies, idempotent. Creates the realm from the export
when it is missing; when it exists, brings the two clients in line with the
export (settings, redirect URIs, web origins, protocol mappers), keeps the
realm's display name and login theme as the export says (the theme only once
the server has it installed — see below), and touches nothing else.

```sh
export KC_URL=https://auth.tinydata.in
export KC_ADMIN_USER=admin KC_ADMIN_PASSWORD='…'    # or KC_ADMIN_TOKEN=<bearer>
node deploy/keycloak/provision.mjs --dry-run             # show what would change
node deploy/keycloak/provision.mjs --web-origin https://dev.csq.aero      # the app lives at https://dev.csq.aero/app/
node deploy/keycloak/provision.mjs --users deploy/keycloak/users.json
```

| flag | effect |
| --- | --- |
| `--web-origin <origin>` | adds `<origin>` to the web origins and `<origin>/*` to the redirect and post-logout redirect URIs of `csq-frontend`; repeatable; existing entries are kept; when the realm is created the first origin is also the client's Root URL (never changed afterwards) |
| `--users <file>` | creates the users in the file (below); existing users keep their password and only get names / flags updated; prints `created|kept <keycloak id> <email>` |
| `--resend-emails` | with `--users`: send the UPDATE_PASSWORD e-mail again to existing users who still have not set a password (never sent twice otherwise) |
| `--realm-file <path>` | another export (default `realm/csq-realm.json` next to the script) |
| `--realm <name>` | realm name when it differs from the export |
| `--dry-run` | reads only; every write is printed as `would …` |

Admin credentials are the Keycloak master-realm admin (`KC_ADMIN_REALM` and
`KC_ADMIN_CLIENT_ID` override `master` / `admin-cli`). The script never prints
the token, a password, or a token-endpoint response.

### users file

`users.example.json` lists the demo accounts `npm run seed:demo` expects
(`acfi.admin@example.in` is the demo super admin, the `*.example.in`
addresses are the operator admins and ACFI analyst it creates) plus one
real-address example. Copy it to `users.json` (git-ignored) and edit.

```json
{ "email": "…", "firstName": "…", "lastName": "…",
  "temporaryPassword": "…"  |  "sendResetEmail": true }
```

- `temporaryPassword`: set at creation and must be changed at first sign-in.
  Never re-applied to an existing user.
- `sendResetEmail`: Keycloak sends an UPDATE_PASSWORD action e-mail (link
  valid 7 days, lands on the first `--web-origin`). Requires SMTP in the
  realm (Realm settings → Email in the console; credentials stay out of
  git). Sent once, at creation; `--resend-emails` sends it again to users
  who still have not set a password.
- Neither: the account is created without a credential and an administrator
  sets one in the console.

Every account is created enabled with `emailVerified: true` and
`username = email`. Fictional `example.in` addresses cannot receive e-mail,
so the demo accounts use temporary passwords.

## Login theme

`theme/csq/` restyles Keycloak's sign-in, first-sign-in password, reset,
error and info pages to the landing page's design. It has to be copied onto
the Keycloak host (`<keycloak>/themes/csq`, then a restart); the export's
`"loginTheme": "csq"` and `provision.mjs` do the rest. `theme/README.md`
has the steps and how to preview it.

## Console alternative

Admin console → Create realm → Browse → `realm/csq-realm.json`, then add the
deployed web origin and redirect URI to `csq-frontend`, and Users → Add user
with the e-mail, email verified, Credentials → set password.

## The API's side

```
KEYCLOAK_ISSUER=https://auth.tinydata.in/realms/csq
KEYCLOAK_JWKS_URI=https://auth.tinydata.in/realms/csq/protocol/openid-connect/certs
KEYCLOAK_AUDIENCE=csq-api
```

`KEYCLOAK_ADMIN_URL` / `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`
are accepted by `src/config/env.ts` for the API's own user provisioning with
a confidential service-account client (realm-management `manage-users`); until
that is wired, `provision.mjs --users` is the way to create accounts.
