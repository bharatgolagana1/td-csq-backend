# CSQ deployment runbook (one host, dev.csq.aero)

Everything to stand up, verify, operate and roll back the CSQ platform on
the Linux host that already serves the landing site. One hostname, no new
DNS records, no new certificates: the app lives under `/app/` and the API
under `/api/` beside the landing page. Paths are relative to this repository
unless absolute.

```
                     ┌──────────── host nginx (443, dev.csq.aero) ──────────────┐
 browser ──────────▶ │ /        ─▶ 127.0.0.1:8080  landing container (already there) │
                     │ /app/    ─▶ 127.0.0.1:8081  csq-web  (nginx inside the image)  │
                     │ /api/    ─▶ 127.0.0.1:4000  csq-api ─▶ mongo (compose-internal) │
                     └────────────────────────────────────────────────────────────┘
 browser ──────────▶ https://auth.tinydata.in/realms/csq   Keycloak (hosted elsewhere)
```

| piece | where | notes |
| --- | --- | --- |
| `csq-api` | `Dockerfile`, `docker-compose.yml` | Node 22, non-root, `/api/v1/health`; the only scheduler instance |
| `csq-web` | `../td-csq-frontend/Dockerfile` | Vite build with `VITE_BASE_PATH=/app/` and the other `VITE_*` baked in; nginx on 8080 serving `/app/` only |
| `mongo` | `docker-compose.yml` | mongo 7, single-node replica set `rs0`, volume `csq_mongo-data`, no published port |
| landing | `../td-csq-frontend/landing/` | already running on the box, published on 127.0.0.1:8080; not part of the compose stack |
| host nginx | `deploy/nginx/csq-single-host.conf` | TLS with the landing's certificate, one vhost, three locations, 10 MB bodies |
| Keycloak | `deploy/keycloak/` | realm `csq`; client `csq-frontend` already allows `https://dev.csq.aero/*` |

## Which nginx file

| file | layout | use it when |
| --- | --- | --- |
| `deploy/nginx/csq-single-host.conf` | `dev.csq.aero/` landing · `/app/` web · `/api/` API | **Now; this runbook.** Replaces the vhost that serves the landing today and reuses its certificate. |
| `deploy/nginx/csq.conf` + `csq-bootstrap.conf` | `app.dev.csq.aero` · `api.dev.csq.aero` | Only for a later move to separate hostnames. Needs two DNS records, two certificates (bootstrap vhost → certbot → real vhost, as the file's header says), the web image built with `VITE_BASE_PATH=/` after changing its `deploy/nginx/nginx.conf` to serve `/`, the web container published on 8080, `PUBLIC_WEB_URL=https://app.dev.csq.aero` and `CORS_ORIGINS=https://app.dev.csq.aero`. Kept for that; not maintained for this box. |

## 1. First deploy

In this order. Steps 1–6 touch nothing public; the switch-over is steps 7–8
and takes one `nginx reload`.

### 1. SSH in and check the box

```sh
ssh <user>@dev.csq.aero
docker compose version                   # Compose plugin ≥ 2.24 (deploy/compose.dev.yml uses !override)
docker ps                                # the landing container: which host port is it published on? (expected 127.0.0.1:8080)
sudo certbot certificates                # the dev.csq.aero certificate and its paths
free -m                                  # ≥ 2 GB RAM free: the Vite build (echarts) needs it
```

If the box has less than 2 GB, build the web image elsewhere and ship it
instead of building in step 3:

```sh
# on a machine with Docker and ≥ 2 GB
cd td-csq-frontend && docker build -t csq-web:$(git rev-parse --short HEAD) .
docker save csq-web:<tag> | gzip > csq-web.tgz && scp csq-web.tgz <user>@dev.csq.aero:/opt/csq/
# on the box: load it, then `docker compose build api` only (WEB_TAG=<tag> in .env)
docker load < /opt/csq/csq-web.tgz
```

### 2. Clone both repositories

Side by side, as `docker-compose.yml` expects (`WEB_CONTEXT` overrides the
location of the web checkout):

```sh
sudo mkdir -p /opt/csq/backups && sudo chown -R "$USER" /opt/csq && cd /opt/csq
git clone <backend remote> td-csq-backend
git clone <web remote>     td-csq-frontend
cd /opt/csq/td-csq-backend
```

### 3. Build the images on the box

```sh
export API_TAG=$(git rev-parse --short HEAD)
export WEB_TAG=$(git -C ../td-csq-frontend rev-parse --short HEAD)
docker compose build                                   # csq-api:$API_TAG and csq-web:$WEB_TAG
printf 'API_TAG=%s\nWEB_TAG=%s\n' "$API_TAG" "$WEB_TAG" > .env   # later compose calls see the tags
docker image ls 'csq-*'
```

Tags are commit SHAs, which is what makes rollback a one-liner (section 8).
`.env` is git-ignored; the API reads `deploy/api.env`, not this file.

The web image is configured at build time (Vite inlines
`import.meta.env.VITE_*`; there is no runtime config). The compose defaults
are the single-host layout:

| build arg | default | meaning |
| --- | --- | --- |
| `VITE_BASE_PATH` | `/app/` | public path: Vite `base` and router basename; the image's nginx serves exactly this path and the build refuses any other value |
| `VITE_API_BASE_URL` | `/api/v1` | same origin as the app, through the host nginx |
| `VITE_KEYCLOAK_URL` | `https://auth.tinydata.in/` | |
| `VITE_KEYCLOAK_REALM` | `csq` | |
| `VITE_KEYCLOAK_CLIENT_ID` | `csq-frontend` | |

The same values shape the web container's Content-Security-Policy
(`connect-src`, `frame-src`), rendered at build by
`../td-csq-frontend/deploy/render-headers.mjs`. Changing any of them means
`docker compose build web`.

### 4. `deploy/api.env` with the secrets

The API's environment is `deploy/api.env` (git-ignored), copied from
`deploy/api.env.example`. `src/config/env.ts` validates every variable at
boot and the container exits listing every problem, so a bad file is caught
on `docker compose up`. Section 3 explains each variable; the example file
already carries the single-host values (`CORS_ORIGINS=https://dev.csq.aero`,
`PUBLIC_WEB_URL=https://dev.csq.aero/app`).

```sh
cp deploy/api.env.example deploy/api.env && chmod 600 deploy/api.env
```

Secrets come from AWS SSM Parameter Store (SecureString) and are written
straight into the file, never echoed:

```sh
get() { aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text; }
sed -i "s|^LINK_SESSION_SECRET=.*|LINK_SESSION_SECRET=$(get /csq/dev/link-session-secret)|" deploy/api.env
sed -i "s|^# SMTP_URL=.*|SMTP_URL=$(get /csq/dev/smtp-url)|"                           deploy/api.env
```

To create the link secret the first time: `openssl rand -base64 48` →
`aws ssm put-parameter --type SecureString --name /csq/dev/link-session-secret --value '…'`.
Without SSM, paste the values in by hand; `LINK_SESSION_SECRET` must be at
least 32 characters and `SMTP_URL` may stay unset for a demo (e-mails then
go to the `notifications` collection and the log only).

### 5. Start the stack

```sh
docker compose up -d mongo            # healthcheck initiates rs0 on first run
docker compose up -d                  # api waits for mongo to be healthy; web starts at once
docker compose ps                     # all three "healthy"
docker compose logs api | tail -20    # "csq-api listening"
curl -s http://127.0.0.1:4000/api/v1/health      # {"status":"ok","mongo":true,…}
curl -sI http://127.0.0.1:8081/app/ | head -1    # HTTP/1.1 200
```

Nothing is public yet: both containers listen on 127.0.0.1 only.

### 6. Seed

Inside the image the seed runs from `dist/` (same code as `npm run seed`,
compiled; the YAML survey bank and the airports CSV are copied into `dist/`
by the build):

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

> **Seed demo data with the API stopped.** The running API's `invitations.expire`
> job marks any invitation whose window has passed as expired every minute, and
> the demo seed builds *past* cycles — so it must run without the scheduler:
>
> ```sh
> docker compose stop api
> docker compose run --rm --no-deps -T api node dist/seed/demo.js --reset        # optional: wipe demo data
> docker compose run --rm --no-deps -T api node dist/seed/demo.js --super-admin email=… name="…"
> docker compose start api
> ```


Without `--super-admin` the demo acts as `acfi.admin@example.in`.

### 7. Install `csq-single-host.conf`

The new file is the whole vhost for `dev.csq.aero`, so the file that serves
the landing today must be disabled at the same time: nginx does not fail on
two `server` blocks with the same name, it warns and keeps using the first
one it loaded, which would silently leave `/app/` unreachable.

```sh
# what serves dev.csq.aero today, and does the new file agree with it?
grep -rl 'dev.csq.aero' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
grep -hE 'ssl_certificate|proxy_pass|listen' /etc/nginx/sites-enabled/<old-landing-vhost>
```

Compare with `deploy/nginx/csq-single-host.conf`: the `ssl_certificate`
paths must match (`/etc/letsencrypt/live/dev.csq.aero/` is the default for a
certificate issued as `-d dev.csq.aero`), and `upstream csq_landing` must be
the landing container's published port (127.0.0.1:8080). Edit the copy if
not. Then swap:

```sh
sudo install -m 644 deploy/nginx/csq-single-host.conf /etc/nginx/sites-available/csq.conf
sudo ln -sf /etc/nginx/sites-available/csq.conf /etc/nginx/sites-enabled/csq.conf
sudo mv /etc/nginx/sites-enabled/<old-landing-vhost> /etc/nginx/sites-available/<old-landing-vhost>.disabled
```

(On a `conf.d`-style install use `/etc/nginx/conf.d/csq.conf` and rename the
old file to something that does not end in `.conf`.) Certificate renewal: if
`/etc/letsencrypt/renewal/dev.csq.aero.conf` says `authenticator = webroot`,
set `webroot_path` there to `/var/www/certbot` (the path the port-80 block
serves) or change the block to the existing path; any other authenticator
is untouched by this change. `sudo certbot renew --dry-run` confirms.

### 8. `nginx -t && reload`

```sh
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` failing changes nothing: fix the file or put the old symlink
back, and test again. After the reload:

- https://dev.csq.aero/ is the landing site, unchanged;
- https://dev.csq.aero/app/ shows the Keycloak sign-in;
- https://dev.csq.aero/api/v1/health answers `{"status":"ok","mongo":true,…}`.

### 9. Smoke test

```sh
deploy/smoke.sh https://dev.csq.aero
```

Every line `ok`, exit status 0. Section 5 lists what it checks. It can also
be pointed straight at the containers, bypassing nginx:

```sh
API_URL=http://127.0.0.1:4000 WEB_URL=http://127.0.0.1:8081/app CORS_ORIGIN=https://dev.csq.aero deploy/smoke.sh
```

### 10. Keycloak users and the first sign-in

Every CSQ account stays INVITED until a Keycloak account with the same
e-mail signs in once. Copy `deploy/keycloak/users.example.json` to
`deploy/keycloak/users.json` (git-ignored), put your own address in it with
`sendResetEmail: true` (needs SMTP configured on the realm) or a
`temporaryPassword`, keep the `*.example.in` demo accounts if you seeded the
demo, then (Node 22 on the box or on your machine, section 4 for the
credentials):

```sh
node deploy/keycloak/provision.mjs --web-origin https://dev.csq.aero --users deploy/keycloak/users.json
```

It prints `created|kept <keycloak id> <email>`. Sign in at
https://dev.csq.aero/app/ with the super-admin address; the first request
links the Keycloak `sub` and activates the account. Then open Settings, open
a cycle from the demo, and check `docker compose logs api` for anything at
`warn` or above.

## 2. Updating

```sh
cd /opt/csq/td-csq-backend
git pull --ff-only && git -C ../td-csq-frontend pull --ff-only
export API_TAG=$(git rev-parse --short HEAD) WEB_TAG=$(git -C ../td-csq-frontend rev-parse --short HEAD)
docker compose build && docker compose up -d          # recreates only what changed
docker compose exec api node dist/seed/seed.js        # new modules get their default grants
printf 'API_TAG=%s\nWEB_TAG=%s\n' "$API_TAG" "$WEB_TAG" > .env
deploy/smoke.sh https://dev.csq.aero
```

Before `up`, check the diff of `deploy/api.env.example` for new variables,
of `deploy/nginx/csq-single-host.conf` for proxy changes (re-run step 7–8 if
so) and of `deploy/keycloak/realm/csq-realm.json` for client changes (re-run
`provision.mjs` if so). Take a backup first (section 6) when the release
notes mention a data migration. The web build needs the same ≥ 2 GB as the
first one; the `docker save` / `docker load` route from step 1 works for
updates too.

## 3. Environment reference

`deploy/api.env`, validated at boot by `src/config/env.ts`.

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
| `CORS_ORIGINS` | `https://dev.csq.aero` | comma-separated browser origins (scheme + host, no path); the app shares the API's origin, so this is the one hostname; `deploy/smoke.sh` checks it |
| `PUBLIC_WEB_URL` | `https://dev.csq.aero/app` | the app root including its base path, no trailing slash; every link the API e-mails is `${PUBLIC_WEB_URL}/assess/<token>`, `/register/<token>` or `/registrations/<id>` (`src/core/web-url.ts` joins them, so a trailing slash is tolerated) |
| `LINK_SESSION_SECRET` | secret | ≥ 32 chars, SSM `/csq/dev/link-session-secret`; rotating it kills every outstanding assessment / registration link |
| `SMTP_URL` | secret or unset | `smtp(s)://user:pass@host:port`, SSM `/csq/dev/smtp-url`; unset = e-mails go to the `notifications` collection and the log only |
| `MAIL_FROM` | `CSQ <no-reply@acfi.in>` | |
| `DEMO_REVEAL_OTP` | `false` | `true` returns assessment OTPs in API responses so a demo works without e-mail; never where real customers are assessed |
| `SCHEDULER_ENABLED` | `true` | the minute tick; exactly one API instance must run it |

## 4. Keycloak

Keycloak is hosted at `https://auth.tinydata.in/`, realm `csq`. The public
client `csq-frontend` already lists `https://dev.csq.aero/*` among its
redirect URIs, which covers `/app/…` (sign-in returns to the page that
asked, sign-out to `https://dev.csq.aero/app/`). `deploy/keycloak/README.md`
has the details; to confirm or repair the client (idempotent, so safe to
re-run):

```sh
export KC_URL=https://auth.tinydata.in
export KC_ADMIN_USER=admin
read -rs KC_ADMIN_PASSWORD && export KC_ADMIN_PASSWORD     # typed, not in history

node deploy/keycloak/provision.mjs --web-origin https://dev.csq.aero --dry-run
node deploy/keycloak/provision.mjs --web-origin https://dev.csq.aero
```

This creates realm `csq` with clients `csq-frontend` (public, PKCE, audience
mapper) and `csq-api` (bearer-only) from `deploy/keycloak/realm/csq-realm.json`
when it is missing, or brings an existing realm's clients in line, adding
the origin to the web origins and `<origin>/*` to the redirect and
post-logout redirect URIs. Users: step 10 above.

## 5. What the smoke test checks

`deploy/smoke.sh <base url>`: API health (Mongo ping), 401 without a token
on `/me` and `/users`, CORS for the app origin and its preflight, SPA index
at `/app/` with `no-cache`, deep link fallback (`/app/cycles/…`), missing
asset under `/app/assets/` is 404, the hashed bundle is `immutable`, CSP and
`nosniff` present, HSTS on https, `/app/healthz`, `/app` → `/app/`, and that
`/` is still the landing page (an `id="root"` body there means the app took
over the root). Exit status 1 on any failure.

## 6. Backups

Mongo is the only state (plus the certificate, which certbot renews).

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

## 7. Logs

- API: JSON lines on stdout, `docker compose logs -f --since 1h api`
  (`LOG_LEVEL` in `deploy/api.env`; every response carries `x-request-id`,
  which the web app shows in error toasts, so grep for it).
- Web container: nginx access log on stdout, `docker compose logs -f web`.
- Host nginx: `/var/log/nginx/csq.access.log`, `/var/log/nginx/csq.error.log`
  (one vhost, so one pair; the path tells `/app/` from `/api/` from `/`).
- Landing container: `docker logs <landing container>`.
- Mongo: `docker compose logs mongo`.

Container logs rotate at 5 × 20 MB per service (`logging` in the compose
file). Sent e-mails, including the ones that went nowhere because `SMTP_URL`
is unset, are in the `notifications` collection and under Notifications in
the app.

## 8. Rollback

Images stay on the box under their commit tags (`docker image ls 'csq-*'`),
so rolling back is starting the previous tag:

```sh
API_TAG=<previous sha> WEB_TAG=<previous sha> docker compose up -d
```

and putting those values back in `.env`. The seed is additive (it only
upserts and never removes), so an older API runs against a newer seed; if a
release changed documents in a way the old code cannot read, restore the
backup taken before the upgrade (section 6). To rebuild an old tag that was
pruned: `git checkout <sha>` in the repository concerned, `docker compose
build <service>`, `git checkout main`. The nginx file is not versioned by
tag: `git show <sha>:deploy/nginx/csq-single-host.conf` if the proxy rules
changed between releases.

## Local development with the same files

```sh
docker compose -f docker-compose.yml -f deploy/compose.dev.yml up -d mongo   # Mongo only, API on the host
docker compose -f docker-compose.yml -f deploy/compose.dev.yml up --build    # whole stack: web on http://localhost:5173/app/, API on :4000
```

The override reads `deploy/api.env.example` with development values on top,
publishes Mongo on `127.0.0.1:27017` (so `MONGO_URI=mongodb://127.0.0.1:27017/csq?replicaSet=rs0`
from `.env.example` works for `npm run dev` and `npm test`), builds the web
app against `http://localhost:4000` and sets `PUBLIC_WEB_URL=http://localhost:5173/app`.
Port 5173 is used because the Keycloak client already allows
`http://localhost:5173/*`; the image always serves the app under `/app/`.
(`npm run dev` in the web repository serves it at `http://localhost:5173/`
with no base path, which is the usual way to work on it.)
