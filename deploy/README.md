# CSQ deployment runbook (one box, dev.csq.aero)

Everything to stand up, verify, operate and roll back the CSQ platform on a
single Linux host with Docker. Paths are relative to this repository unless
absolute.

```
                 ┌───────────────── host nginx (443) ─────────────────┐
 browser ──────▶ │ dev.csq.aero       landing (already there, untouched)│
                 │ app.dev.csq.aero ─▶ 127.0.0.1:8080  csq-web          │
                 │ api.dev.csq.aero ─▶ 127.0.0.1:4000  csq-api ─▶ mongo │
                 └────────────────────────────────────────────────────┘
 browser ──────▶ https://auth.tinydata.in/realms/csq   Keycloak (hosted elsewhere)
```

| piece | where | notes |
| --- | --- | --- |
| `csq-api` | `Dockerfile`, `docker-compose.yml` | Node 22, non-root, `/api/v1/health`; the only scheduler instance |
| `csq-web` | `../td-csq-frontend/Dockerfile` | Vite build with `VITE_*` baked in, nginx on 8080 |
| `mongo` | `docker-compose.yml` | mongo 7, single-node replica set `rs0`, volume `csq_mongo-data` |
| host nginx | `deploy/nginx/csq.conf` | TLS, two vhosts, 10 MB bodies |
| Keycloak | `deploy/keycloak/` | realm `csq`, provisioned over the admin API |

## 1. DNS

Two A (and AAAA, if the box has IPv6) records to the box's public address:

```
api.dev.csq.aero   A   <box>
app.dev.csq.aero   A   <box>
```

`dev.csq.aero` already points here. Wait for both names to resolve before
asking for certificates (`dig +short app.dev.csq.aero`).

## 2. Box prerequisites

Ubuntu 22.04 / 24.04 or similar, with:

- Docker Engine 24+ with the Compose plugin ≥ 2.24 (`docker compose version`;
  `deploy/compose.dev.yml` uses the `!override` tag).
- nginx ≥ 1.18 and certbot (`apt install nginx certbot`). The landing vhost
  is already configured; keep it.
- git, and the AWS CLI if secrets come from SSM (section 6).
- Ports 80 and 443 open; nothing else. The containers bind `127.0.0.1` only.

Check out both repositories side by side, as the compose file expects
(`WEB_CONTEXT` overrides the location):

```sh
sudo mkdir -p /opt/csq && sudo chown "$USER" /opt/csq && cd /opt/csq
git clone <backend remote> td-csq-backend
git clone <web remote>     td-csq-frontend
```

## 3. Certificates

`csq.conf` references `/etc/letsencrypt/live/{api,app}.dev.csq.aero/`, and
nginx will not load a vhost whose certificate is missing. So: bootstrap
vhost first, certificates second, real vhost third.

```sh
cd /opt/csq/td-csq-backend
sudo mkdir -p /var/www/certbot
sudo install -m 644 deploy/nginx/csq-bootstrap.conf /etc/nginx/sites-available/csq.conf
sudo ln -sf /etc/nginx/sites-available/csq.conf /etc/nginx/sites-enabled/csq.conf
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/certbot -d api.dev.csq.aero
sudo certbot certonly --webroot -w /var/www/certbot -d app.dev.csq.aero

sudo install -m 644 deploy/nginx/csq.conf /etc/nginx/sites-available/csq.conf
sudo nginx -t && sudo systemctl reload nginx
```

(On a `conf.d`-style install use `/etc/nginx/conf.d/csq.conf` and skip the
symlink.) Renewal: certbot's systemd timer renews through the same webroot;
make nginx pick the new files up with

```sh
sudo sh -c 'echo "systemctl reload nginx" > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh' \
  && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

Until the containers are up, the two hostnames answer 502 from nginx; that
is expected.

## 4. Keycloak

Keycloak is hosted at `https://auth.tinydata.in/`. `deploy/keycloak/README.md`
has the details; the short form:

```sh
cd /opt/csq/td-csq-backend
export KC_URL=https://auth.tinydata.in
export KC_ADMIN_USER=admin
read -rs KC_ADMIN_PASSWORD && export KC_ADMIN_PASSWORD     # typed, not in history

node deploy/keycloak/provision.mjs --web-origin https://app.dev.csq.aero --dry-run
node deploy/keycloak/provision.mjs --web-origin https://app.dev.csq.aero
```

This creates realm `csq` with clients `csq-frontend` (public, PKCE, audience
mapper) and `csq-api` (bearer-only) from `deploy/keycloak/realm/csq-realm.json`,
or brings an existing realm's clients in line, and registers the app's
origin and redirect URIs. Re-run it any time; it is idempotent.

Users are created in step 8, after the database is seeded, so that the
e-mails match.

## 5. Images

Images are built on the box and tagged with each repository's commit, which
is what makes rollback a one-liner (section 12).

```sh
cd /opt/csq/td-csq-backend
export API_TAG=$(git rev-parse --short HEAD)
export WEB_TAG=$(git -C ../td-csq-frontend rev-parse --short HEAD)
docker compose build            # csq-api:$API_TAG and csq-web:$WEB_TAG
docker image ls 'csq-*'
```

The web image needs the public URLs at build time, because Vite inlines
`import.meta.env.VITE_*` into the bundle (`src/auth/keycloak.ts`,
`src/api/client.ts`); there is no runtime configuration. The defaults in
`docker-compose.yml` are the dev box's:

| build arg | default |
| --- | --- |
| `VITE_API_BASE_URL` | `https://api.dev.csq.aero/api/v1` |
| `VITE_KEYCLOAK_URL` | `https://auth.tinydata.in/` |
| `VITE_KEYCLOAK_REALM` | `csq` |
| `VITE_KEYCLOAK_CLIENT_ID` | `csq-frontend` |

The same values shape the web container's Content-Security-Policy
(`connect-src`, `frame-src`), rendered at build by
`../td-csq-frontend/deploy/render-headers.mjs`. Changing any of them means
`docker compose build web`.

Put `API_TAG` / `WEB_TAG` (and any build-arg override) in `/opt/csq/td-csq-backend/.env`
so later `docker compose` invocations see them without exporting:

```sh
printf 'API_TAG=%s\nWEB_TAG=%s\n' "$API_TAG" "$WEB_TAG" > .env
```

(`.env` is git-ignored. The API itself reads `deploy/api.env`, not this file.)

## 6. Environment

The API's environment is `deploy/api.env` (git-ignored), copied from
`deploy/api.env.example`. `src/config/env.ts` validates every variable at
boot and the container exits listing every problem, so a bad file is caught
on `docker compose up`.

```sh
cp deploy/api.env.example deploy/api.env && chmod 600 deploy/api.env
```

| variable | value on the dev box | notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | JSON logs, no pretty printing |
| `PORT` | `4000` | the container port; compose publishes it on 127.0.0.1 |
| `MONGO_URI` | `mongodb://mongo:27017/csq?directConnection=true` | `directConnection` because the replica-set member is advertised as 127.0.0.1 (see the compose healthcheck); transactions still work |
| `LOG_LEVEL` | `info` | `debug` when chasing something |
| `KEYCLOAK_ISSUER` | `https://auth.tinydata.in/realms/csq` | must equal the `iss` claim exactly |
| `KEYCLOAK_JWKS_URI` | `https://auth.tinydata.in/realms/csq/protocol/openid-connect/certs` | |
| `KEYCLOAK_AUDIENCE` | `csq-api` | the audience mapper on `csq-frontend` adds it |
| `KEYCLOAK_ADMIN_URL` | unset | optional trio for API-side user provisioning; all three or none |
| `KEYCLOAK_ADMIN_CLIENT_ID` | unset | |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | unset | secret, SSM `/csq/dev/keycloak-admin-client-secret` when used |
| `CORS_ORIGINS` | `https://app.dev.csq.aero` | comma-separated browser origins; `deploy/smoke.sh` checks it |
| `PUBLIC_WEB_URL` | `https://app.dev.csq.aero` | where e-mails and onboarding links point |
| `LINK_SESSION_SECRET` | secret | ≥ 32 chars, SSM `/csq/dev/link-session-secret`; rotating it kills every outstanding assessment / registration link |
| `SMTP_URL` | secret or unset | `smtp(s)://user:pass@host:port`, SSM `/csq/dev/smtp-url`; unset = e-mails go to the `notifications` collection and the log only |
| `MAIL_FROM` | `CSQ <no-reply@acfi.in>` | |
| `DEMO_REVEAL_OTP` | `false` | `true` returns assessment OTPs in API responses so a demo works without e-mail; never where real customers are assessed |
| `SCHEDULER_ENABLED` | `true` | the minute tick; exactly one API instance must run it |

Secrets come from AWS SSM Parameter Store (SecureString) and are written
straight into the file, never echoed:

```sh
get() { aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text; }
sed -i "s|^LINK_SESSION_SECRET=.*|LINK_SESSION_SECRET=$(get /csq/dev/link-session-secret)|" deploy/api.env
sed -i "s|^# SMTP_URL=.*|SMTP_URL=$(get /csq/dev/smtp-url)|"                           deploy/api.env
```

To create the link secret the first time: `openssl rand -base64 48` →
`aws ssm put-parameter --type SecureString --name /csq/dev/link-session-secret --value '…'`.

## 7. First boot

```sh
cd /opt/csq/td-csq-backend
docker compose up -d mongo            # healthcheck initiates rs0 on first run
docker compose up -d                  # api waits for mongo to be healthy
docker compose ps                     # all three "healthy"
docker compose logs api | tail -20    # "csq-api listening"
```

Seed the database. Inside the image the seed runs from `dist/` (same code
as `npm run seed`, compiled; the YAML survey bank and the airports CSV are
copied into `dist/` by the build):

```sh
docker compose exec api node dist/seed/seed.js \
  --super-admin email=you@acfi.in name="Your Name"
```

This upserts tasks, the six roles, the default Role → Task matrix, settings,
the ACFI organisation, the Indian airport list (14 Phase-I airports active)
and the two survey definitions, and creates the first `SUPER_ADMIN` as
INVITED. Re-run it after every upgrade; it never overwrites what an
administrator changed.

Demo dataset (operators, customers, cycles, assessments, scores; every figure
illustrative) on top of that:

```sh
docker compose exec api node dist/seed/demo.js --super-admin email=you@acfi.in name="Your Name"
# --reset rebuilds everything tagged demo:true
```

Without `--super-admin` the demo acts as `acfi.admin@example.in`.

## 8. Keycloak users

Every CSQ account stays INVITED until a Keycloak account with the same
e-mail signs in once. Copy `deploy/keycloak/users.example.json` to
`deploy/keycloak/users.json` (git-ignored), put your own address in it with
`sendResetEmail: true` (needs SMTP configured on the realm) or a
`temporaryPassword`, keep the `*.example.in` demo accounts if you seeded the
demo, then:

```sh
node deploy/keycloak/provision.mjs --web-origin https://app.dev.csq.aero \
  --users deploy/keycloak/users.json
```

It prints `created|kept <keycloak id> <email>`. Sign in at
https://app.dev.csq.aero with the super-admin address; the first request
links the Keycloak `sub` and activates the account.

## 9. Verification

```sh
deploy/smoke.sh                                         # public URLs
API_URL=http://127.0.0.1:4000 WEB_URL=http://127.0.0.1:8080 \
  CORS_ORIGIN=https://app.dev.csq.aero deploy/smoke.sh  # containers directly
```

Checks: API health (Mongo ping), 401 without a token on `/me` and `/users`,
CORS for the app origin and its preflight, SPA index with `no-cache`, deep
link fallback, missing asset is 404, hashed bundle is `immutable`, CSP and
`nosniff` present, HSTS on https, `/healthz`. Exit status 1 on any failure.

Then sign in, open Settings, open a cycle from the demo, and check
`docker compose logs api` for anything at `warn` or above.

## 10. Backups

Mongo is the only state (plus the certificates, which certbot re-issues).

```sh
# dump (gzip archive, consistent for a single node)
docker compose exec -T mongo mongodump --archive --gzip --db csq > /opt/csq/backups/csq-$(date +%F-%H%M).archive.gz
# restore into a running stack (drops and replaces the csq database)
docker compose exec -T mongo mongorestore --archive --gzip --drop --nsInclude 'csq.*' < csq-2026-10-08-0200.archive.gz
```

Cron, nightly at 02:00, keeping 14 days:

```
0 2 * * * cd /opt/csq/td-csq-backend && docker compose exec -T mongo mongodump --archive --gzip --db csq > /opt/csq/backups/csq-$(date +\%F).archive.gz && find /opt/csq/backups -name 'csq-*.archive.gz' -mtime +14 -delete
```

Copy `/opt/csq/backups` off the box (S3 sync or equivalent); a backup on the
same disk is not a backup. Keep `deploy/api.env` and `deploy/keycloak/users.json`
out of backups that leave the box, or encrypt them.

## 11. Logs

- API: JSON lines on stdout, `docker compose logs -f --since 1h api`
  (`LOG_LEVEL` in `deploy/api.env`; every response carries `x-request-id`,
  which the web app shows in error toasts, so grep for it).
- Web container: nginx access log on stdout, `docker compose logs -f web`.
- Host nginx: `/var/log/nginx/csq-api.*.log`, `/var/log/nginx/csq-web.*.log`.
- Mongo: `docker compose logs mongo`.

Container logs rotate at 5 × 20 MB per service (`logging` in the compose
file). Sent e-mails, including the ones that went nowhere because `SMTP_URL`
is unset, are in the `notifications` collection and under Notifications in
the app.

## 12. Upgrade

```sh
cd /opt/csq/td-csq-backend
git pull --ff-only && git -C ../td-csq-frontend pull --ff-only
export API_TAG=$(git rev-parse --short HEAD) WEB_TAG=$(git -C ../td-csq-frontend rev-parse --short HEAD)
docker compose build
docker compose up -d                         # recreates only what changed
docker compose exec api node dist/seed/seed.js   # new modules get their default grants
printf 'API_TAG=%s\nWEB_TAG=%s\n' "$API_TAG" "$WEB_TAG" > .env
deploy/smoke.sh
```

Check `deploy/api.env.example` in the diff for new variables before `up`,
and `deploy/keycloak/realm/csq-realm.json` for client changes (re-run
`provision.mjs` if so). Take a backup first when the release notes mention a
data migration.

## 13. Rollback

Images stay on the box under their commit tags (`docker image ls 'csq-*'`),
so rolling back is starting the previous tag:

```sh
API_TAG=<previous sha> WEB_TAG=<previous sha> docker compose up -d
```

and putting those values back in `.env`. The seed is additive (it only
upserts and never removes), so an older API runs against a newer seed; if a
release changed documents in a way the old code cannot read, restore the
backup taken before the upgrade (section 10). To rebuild an old tag that was
pruned: `git checkout <sha>` in the repository concerned, `docker compose
build <service>`, `git checkout main`.

## Local development with the same files

```sh
docker compose -f docker-compose.yml -f deploy/compose.dev.yml up -d mongo   # Mongo only, API on the host
docker compose -f docker-compose.yml -f deploy/compose.dev.yml up --build    # whole stack: web on http://localhost:5173, API on :4000
```

The override reads `deploy/api.env.example` with development values on top,
publishes Mongo on `127.0.0.1:27017` (so `MONGO_URI=mongodb://127.0.0.1:27017/csq?replicaSet=rs0`
from `.env.example` works for `npm run dev` and `npm test`), and builds the
web app against `http://localhost:4000`. Port 5173 is used because the
Keycloak client already allows `http://localhost:5173/*`.
