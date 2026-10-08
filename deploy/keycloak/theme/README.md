# CSQ login theme

`csq/` is a Keycloak **login** theme: the landing page's look (dark, Archivo +
IBM Plex Mono, the nose image, square buttons) on the sign-in, first-sign-in
password, reset-password, error and info pages. It extends Keycloak's `base`
theme, so every page it does not override (OTP, select-authenticator, page
expired, logout, …) still renders, in the same style, through the class names
in `login/theme.properties`. Built and rendered against Keycloak 25.0.1.

The form ids Keycloak and our browser drivers rely on are unchanged
(`#username`, `#password`, `#kc-login`, `#password-new`, `#password-confirm`,
`#logout-sessions`).

## Install

Keycloak reads themes from `<keycloak>/themes/<name>/` at start-up (the theme
list is cached in production mode), so installing is: copy the folder, restart.

```sh
# bare install
scp -r deploy/keycloak/theme/csq <host>:/opt/keycloak/themes/csq
ssh <host> 'sudo systemctl restart keycloak'

# Keycloak in a container: either bind-mount the folder …
#   -v /srv/keycloak/themes/csq:/opt/keycloak/themes/csq:ro
# … or copy it in and restart the container
docker cp deploy/keycloak/theme/csq <container>:/opt/keycloak/themes/csq
docker restart <container>
```

Then switch the realm to it. `realm/csq-realm.json` already says
`"loginTheme": "csq"`; `provision.mjs` applies it (and the display name) to an
existing realm when the server lists the theme, and says so when it does not:

```sh
KC_URL=https://auth.tinydata.in KC_ADMIN_USER=… KC_ADMIN_PASSWORD=… \
  node deploy/keycloak/provision.mjs --web-origin https://dev.csq.aero
```

Or in the console: realm `csq` → Realm settings → Themes → Login theme → `csq`.

## Editing

- Copy: `login/messages/messages_en.properties` (keys not listed keep
  Keycloak's wording). The home link is `csqHomeUrl` in `theme.properties`.
- Look: `login/resources/css/login.css` uses the landing page's tokens
  (`--bg`, `--ink`, `--r5`, …) from `td-csq-frontend/landing/index.html`; keep
  them in step when the landing changes. The images are the landing's
  `assets/nose-*`.
- Pages: `template.ftl` is the frame; `login.ftl`,
  `login-update-password.ftl`, `login-reset-password.ftl`, `error.ftl` are the
  overridden pages. Anything else comes from `base` — copy the file from the
  Keycloak release of the same version before changing it.
- To preview without touching the real server: run Keycloak with the folder
  mounted and caching off, and point a throwaway realm at it:
  `docker run -p 8089:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=x
  -v $PWD/deploy/keycloak/theme/csq:/opt/keycloak/themes/csq:ro
  quay.io/keycloak/keycloak:25.0.1 start-dev --spi-theme-static-max-age=-1
  --spi-theme-cache-themes=false --spi-theme-cache-templates=false`.
