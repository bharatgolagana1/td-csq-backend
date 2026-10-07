# Keycloak for CSQ

Identity only. Keycloak says *who* the caller is (`sub`, email, name); the
CSQ database says what they may do, through the Role → Task matrix. No
realm or client roles are used for authorisation.

## Realm

`realm/csq-realm.json` creates realm `csq` with two clients:

| client         | kind         | purpose                                                     |
| -------------- | ------------ | ----------------------------------------------------------- |
| `csq-frontend` | public, PKCE | the web app signs in with it; an audience mapper adds `aud=csq-api` to every access token |
| `csq-api`      | bearer-only  | the audience the API checks (`KEYCLOAK_AUDIENCE=csq-api`)    |

Local: `docker compose up keycloak` imports it on start (mounted at
`/opt/keycloak/data/import`). Hosted (`https://auth.tinydata.in/`): Admin
console → Create realm → Browse → this file, or the admin REST API
`POST /admin/realms` with the file as the body. Add the real web origin and
redirect URI of the deployed app to `csq-frontend` afterwards.

## Users

No users are in the export: passwords never belong in git. Create the demo
accounts in the console (Users → Add user, set email verified, Credentials →
set password) or with the admin API, then link each one to a CSQ user:

- the first Super Admin: `pnpm --filter @csq/api seed:platform -- --platform-code ACFI … --admin-kc-user-id <Keycloak user id>`
- everyone else: `POST /v1/orgs/users/:userId/identity` as a platform admin.

The API's `.env` must point at the realm:

```
KEYCLOAK_ISSUER=https://auth.tinydata.in/realms/csq
KEYCLOAK_JWKS_URI=https://auth.tinydata.in/realms/csq/protocol/openid-connect/certs
KEYCLOAK_AUDIENCE=csq-api
```
