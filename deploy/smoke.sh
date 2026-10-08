#!/usr/bin/env bash
# Smoke test for a CSQ deployment: API health, SPA index and fallback,
# asset caching, security headers, CORS, that the API refuses
# unauthenticated calls, and (single host) that / is still the landing site.
# Prints one line per check; exits 1 when any fails.
#
#   deploy/smoke.sh https://dev.csq.aero     # single host: API at /api/, app at /app/, landing at /
#   deploy/smoke.sh                          # the same, against https://dev.csq.aero
#
#   API_URL=http://127.0.0.1:4000 WEB_URL=http://127.0.0.1:8081/app \
#     CORS_ORIGIN=https://dev.csq.aero deploy/smoke.sh          # straight at the containers
#   API_URL=https://api.dev.csq.aero WEB_URL=https://app.dev.csq.aero \
#     deploy/smoke.sh                                             # two-hostname layout (csq.conf)
#
# Needs only bash and curl.
set -uo pipefail

BASE_URL="${1:-https://dev.csq.aero}"
BASE_URL="${BASE_URL%/}"
API_URL="${API_URL:-$BASE_URL}"
WEB_URL="${WEB_URL:-$BASE_URL/app}"
API_URL="${API_URL%/}"
WEB_URL="${WEB_URL%/}"
# scheme://host[:port] of the web app: the browser origin CORS_ORIGINS must
# allow, and what the bundle's root-relative asset URLs resolve against.
WEB_ORIGIN=$(printf '%s' "$WEB_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
CORS_ORIGIN="${CORS_ORIGIN:-$WEB_ORIGIN}"
TIMEOUT="${TIMEOUT:-15}"

pass=0
fail=0
STATUS=""
BODY=""
HEADERS=""

ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# fetch METHOD URL [curl options...] -> STATUS, BODY, HEADERS (CR-stripped)
fetch() {
  local method=$1 url=$2
  shift 2
  local body_file header_file
  body_file=$(mktemp)
  header_file=$(mktemp)
  STATUS=$(curl --silent --show-error --max-time "$TIMEOUT" -X "$method" \
    -o "$body_file" -D "$header_file" -w '%{http_code}' "$@" "$url" 2>/dev/null) || STATUS=000
  BODY=$(cat "$body_file")
  HEADERS=$(tr -d '\r' < "$header_file")
  rm -f "$body_file" "$header_file"
}

# header NAME -> value of the last occurrence, lower-cased name match
header() {
  local name
  name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$HEADERS" | awk -v k="$name" -F': ' 'tolower($1) == k { sub(/^[^:]*: */, ""); v = $0 } END { print v }'
}

contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

printf 'API  %s\nWEB  %s\nCORS %s\n\n' "$API_URL" "$WEB_URL" "$CORS_ORIGIN"

# ---- API --------------------------------------------------------------------
fetch GET "$API_URL/api/v1/health"
if [ "$STATUS" = 200 ] && contains "$BODY" '"status":"ok"' && contains "$BODY" '"mongo":true'; then
  ok "API health is ok (mongo reachable)"
else
  bad "API health" "status $STATUS body: ${BODY:0:200}"
fi

fetch GET "$API_URL/api/v1/me"
if [ "$STATUS" = 401 ] && contains "$BODY" 'UNAUTHENTICATED'; then
  ok "GET /me without a token is 401 UNAUTHENTICATED"
else
  bad "unauthenticated /me" "expected 401 UNAUTHENTICATED, got $STATUS: ${BODY:0:200}"
fi

fetch GET "$API_URL/api/v1/users"
if [ "$STATUS" = 401 ]; then
  ok "GET /users without a token is 401"
else
  bad "unauthenticated /users" "expected 401, got $STATUS"
fi

fetch GET "$API_URL/api/v1/health" -H "Origin: $CORS_ORIGIN"
if [ "$(header access-control-allow-origin)" = "$CORS_ORIGIN" ]; then
  ok "CORS allows $CORS_ORIGIN"
else
  bad "CORS" "access-control-allow-origin is '$(header access-control-allow-origin)', expected '$CORS_ORIGIN' (check CORS_ORIGINS)"
fi

fetch OPTIONS "$API_URL/api/v1/me" -H "Origin: $CORS_ORIGIN" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization,x-csq-org"
if { [ "$STATUS" = 204 ] || [ "$STATUS" = 200 ]; } && contains "$(header access-control-allow-headers | tr '[:upper:]' '[:lower:]')" 'authorization'; then
  ok "CORS preflight accepts Authorization and x-csq-org"
else
  bad "CORS preflight" "status $STATUS allow-headers: '$(header access-control-allow-headers)'"
fi

# ---- web --------------------------------------------------------------------
fetch GET "$WEB_URL/"
index_body=$BODY
if [ "$STATUS" = 200 ] && contains "$(header content-type)" 'text/html' && contains "$BODY" 'id="root"'; then
  ok "SPA index served at $WEB_URL/"
else
  bad "SPA index" "status $STATUS content-type '$(header content-type)'"
fi
if contains "$(header cache-control)" 'no-cache'; then
  ok "index.html is no-cache"
else
  bad "index.html cache" "cache-control is '$(header cache-control)'"
fi
if [ -n "$(header content-security-policy)" ] && [ "$(header x-content-type-options)" = "nosniff" ]; then
  ok "security headers present (CSP, nosniff)"
else
  bad "security headers" "csp: '$(header content-security-policy | cut -c1-60)' nosniff: '$(header x-content-type-options)'"
fi
case "$WEB_URL" in
  https://*)
    if [ -n "$(header strict-transport-security)" ]; then
      ok "HSTS set"
    else
      bad "HSTS" "strict-transport-security missing on $WEB_URL"
    fi
    ;;
esac

fetch GET "$WEB_URL/cycles/smoke-$RANDOM"
if [ "$STATUS" = 200 ] && contains "$BODY" 'id="root"'; then
  ok "deep link falls back to index.html"
else
  bad "SPA fallback" "status $STATUS"
fi

fetch GET "$WEB_URL/assets/does-not-exist-$RANDOM.js"
if [ "$STATUS" = 404 ]; then
  ok "missing asset is 404, not index.html"
else
  bad "missing asset" "expected 404, got $STATUS"
fi

# The bundle's script tag is root-relative (/app/assets/… under a base path,
# /assets/… without one), so it resolves against the origin, not WEB_URL.
asset=$(printf '%s' "$index_body" | grep -o 'src="/[^"]*assets/[^"]*\.js"' | head -n1 | sed 's/^src="//; s/"$//')
if [ -n "$asset" ]; then
  fetch GET "$WEB_ORIGIN$asset"
  if [ "$STATUS" = 200 ] && contains "$(header cache-control)" 'immutable' && contains "$(header content-type)" 'javascript'; then
    ok "bundle $asset is immutable"
  else
    bad "asset caching" "status $STATUS cache-control '$(header cache-control)' content-type '$(header content-type)'"
  fi
else
  bad "asset discovery" "no /…/assets/*.js reference found in index.html"
fi

fetch GET "$WEB_URL/healthz"
if [ "$STATUS" = 200 ]; then
  ok "web $WEB_URL/healthz"
else
  bad "web healthz" "status $STATUS"
fi

# ---- single host only: the base path and the landing site ------------------
if [ "$WEB_URL" != "$WEB_ORIGIN" ]; then
  fetch GET "$WEB_URL"
  location=$(header location)
  if { [ "$STATUS" = 301 ] || [ "$STATUS" = 308 ]; } && contains "$location" "${WEB_URL#"$WEB_ORIGIN"}/"; then
    ok "$WEB_URL redirects to $WEB_URL/"
  else
    bad "base path redirect" "expected 301 to ${WEB_URL#"$WEB_ORIGIN"}/, got $STATUS location '$location'"
  fi

  fetch GET "$WEB_ORIGIN/"
  if [ "$STATUS" = 200 ] && contains "$(header content-type)" 'text/html' && ! contains "$BODY" 'id="root"'; then
    ok "$WEB_ORIGIN/ is still the landing site"
  else
    bad "landing site" "status $STATUS content-type '$(header content-type)' (an id=\"root\" body means the app took over /)"
  fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
