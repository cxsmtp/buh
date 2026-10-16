#!/usr/bin/env bash
# CI (.github/workflows/zero-downtime.yml): the images-only set-up of a Podman server, with
# real containers: the shop (buh:test), the updater image (deploy/updater/Dockerfile) and the
# proxy image (deploy/proxy/Dockerfile), built here from this commit.
#
#   1. the owner's container, as the guide starts it: 127.0.0.1 only, settings from an env file;
#   2. the one-line `setup … --proxy DOMAIN`: binding, settings and data kept; the updater
#      and the HTTPS proxy started (certificates from Caddy's local authority: TLS_INTERNAL);
#   3. the proxy: HTTP → HTTPS, www → domain, 12 MB limit, no Server header, the app's
#      HSTS and CSP once, TLS 1.2+, not root, only NET_BIND_SERVICE;
#   4. a visitor cannot forge X-Real-IP;
#   5. a version switch of the shop under load through the proxy: failed requests counted;
#   6. the proxy updates itself (and a broken proxy image is undone);
#   7. the updater updates itself (and a broken updater image is not used);
#   8. a stopped proxy is started again.
# Needs ports 80 and 443 free on this machine. Against Podman's API instead of Docker:
#   DOCKER_HOST=unix:///run/podman/podman.sock ENGINE_SOCKET=/run/podman/podman.sock deploy/ci/setup-proxy-test.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
NAME=buh-vps
PORT=13000
DOMAIN=shop.test
ENGINE_SOCKET=${ENGINE_SOCKET:-/var/run/docker.sock}
WORK=$(mktemp -d)
SECRET='a secret with spaces $&"'"'"' and = signs'
LATEST=buh:vps-latest
UPDATER_REF=buh-updater:vps-latest
PROXY_REF=buh-proxy:vps-latest

step() { printf '\n==== %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  docker ps -a >&2 || true
  docker logs --tail 60 "$NAME-updater" >&2 || true
  docker logs --tail 30 "$NAME-proxy" >&2 || true
  exit 1
}
id_of() { docker image inspect -f '{{.Id}}' "$1"; }
image_of() { docker inspect -f '{{.Image}}' "$1"; }
wait_for() { # wait_for SECONDS DESCRIPTION COMMAND...
  local limit=$1 what=$2
  shift 2
  for _ in $(seq 1 "$limit"); do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for: $what"
}
derive() { # derive FROM TAG CHANGE
  local c
  c=$(docker create "$1")
  docker commit --change "$3" "$c" "$2" > /dev/null
  docker rm "$c" > /dev/null
}
cleanup() {
  docker rm -f "$NAME-updater" "$NAME-updater-new" "$NAME-updater-old" "$NAME-proxy" "$NAME-proxy-previous" \
    "$NAME" "$NAME-previous" "$NAME-candidate" buh-vps-echo buh-vps-echo-proxy > /dev/null 2>&1 || true
  docker volume rm "$NAME-data" "$NAME-updater-state" "$NAME-updater-control" "$NAME-updater-status" \
    "$NAME-proxy-data" "$NAME-proxy-config" > /dev/null 2>&1 || true
  docker rmi buh:last-good buh:previous "$LATEST" > /dev/null 2>&1 || true
}
cleanup
trap 'touch "$WORK/stop"; cleanup' EXIT

# Through the proxy, as a visitor: the domain points at this machine, the local CA is trusted.
C=(curl --noproxy '*' -s --max-time 30 --cacert "$WORK/ca.crt" --resolve "$DOMAIN:443:127.0.0.1" --resolve "$DOMAIN:80:127.0.0.1"
  --resolve "www.$DOMAIN:443:127.0.0.1")
status_json() { docker exec "$NAME-updater" cat /public/status.json 2> /dev/null || echo '{}'; }
in_shop() { [ "$(docker exec "$NAME" printenv "$1")" = "$2" ] || fail "$1 is not what the owner set"; }

start_load() { # GETs through the proxy every 0.1 s: storefront and health
  rm -f "$WORK/stop" "$WORK/load"
  (
    while [ ! -f "$WORK/stop" ]; do
      for p in / /api/health; do
        printf '%s %s %s\n' "$(date +%s.%N)" "$("${C[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN$p" || echo 000)" "$p" >> "$WORK/load"
      done
      sleep 0.1
    done
  ) &
  LOAD_PID=$!
}
stop_load() {
  touch "$WORK/stop"
  wait "$LOAD_PID" || true
  local total failed slowest
  total=$(wc -l < "$WORK/load")
  failed=$(awk '$2 != 200' "$WORK/load" | wc -l)
  slowest=$(awk 'NR > 1 { d = $1 - prev; if (d > max) max = d } { prev = $1 } END { printf "%.1f", max }' "$WORK/load")
  echo "through the proxy: $total requests, $failed failed, longest wait between answers ${slowest}s"
  [ "$total" -ge 20 ] || fail "too few requests ($total)"
  if [ "$failed" != 0 ]; then awk '$2 != 200' "$WORK/load" | sort -k2 | uniq -c -f1 | head >&2; fi
  LOAD_FAILED=$failed
}

step "images: the updater and the proxy from this commit; shop versions 9.1.0 and 9.1.1"
docker image inspect buh:test > /dev/null || fail "build buh:test first"
# PREBUILT=1: the two images are already there under these names (e.g. built with podman build).
if [ "${PREBUILT:-0}" != 1 ]; then
  docker build --load -q -f deploy/updater/Dockerfile -t "$UPDATER_REF" . > /dev/null
  docker build --load -q -f deploy/proxy/Dockerfile -t "$PROXY_REF" . > /dev/null
fi
derive buh:test buh:9.1.0 'LABEL org.opencontainers.image.version=9.1.0'
derive buh:test buh:9.1.1 'LABEL org.opencontainers.image.version=9.1.1'
derive "$UPDATER_REF" buh-updater:vps-next 'LABEL ci.revision=next'
derive "$UPDATER_REF" buh-updater:vps-broken 'ENTRYPOINT ["/bin/sh","-c","exit 3"]'
derive "$PROXY_REF" buh-proxy:vps-next 'LABEL ci.revision=next'
derive "$PROXY_REF" buh-proxy:vps-broken 'ENTRYPOINT ["caddy","run","--config","/nonexistent"]'
docker tag buh:9.1.0 "$LATEST"

step "1. the owner's container: 127.0.0.1:$PORT only, settings from an env file"
cat > "$WORK/shop.env" << EOF
NEXT_PUBLIC_APP_URL=https://$DOMAIN
TRUST_PROXY=1
TZ=Asia/Dubai
NEXT_PUBLIC_SUPPORT_EMAIL=help@ci.example
SESSION_SECRET=$SECRET
EOF
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -v "$NAME-data:/data" --env-file "$WORK/shop.env" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 2048 buh:9.1.0 > /dev/null
wait_for 90 "the shop" curl --noproxy '*' -sf "http://127.0.0.1:$PORT/api/health"
docker exec "$NAME" node -e "require('fs').writeFileSync('/data/ci-marker', 'x')"

step "2. the one-line set-up, with the HTTPS proxy"
docker run --rm --pids-limit 128 --security-opt label=disable -v "$ENGINE_SOCKET:/var/run/docker.sock" -e "SOCK=unix://$ENGINE_SOCKET" \
  -e PROXY_TLS_INTERNAL=1 -e HEAL_CHECK_SECONDS=3 -e SELF_CHECK_SECONDS=5 -e PROXY_SETTLE_SECONDS=3 \
  "$UPDATER_REF" setup "$NAME" --image "$LATEST" --minutes 0 --proxy "$DOMAIN" --email ci@example.com --proxy-image "$PROXY_REF" \
  | tee "$WORK/setup.log" || fail "setup failed"
grep -q 'Done. Automatic updates are on' "$WORK/setup.log" || fail "no summary"
if grep -qF 'a secret' "$WORK/setup.log"; then fail "a secret reached the output"; fi
[ "$(docker port "$NAME")" = "3000/tcp -> 127.0.0.1:$PORT" ] || fail "the binding changed: $(docker port "$NAME")"
in_shop SESSION_SECRET "$SECRET"
in_shop TRUST_PROXY 1
in_shop NEXT_PUBLIC_APP_URL "https://$DOMAIN"
docker exec "$NAME" test -f /data/ci-marker || fail "the data volume changed"
docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$NAME" | grep -q /updater-control || fail "no request volume"
[ "$(image_of "$NAME-updater")" = "$(id_of "$UPDATER_REF")" ] || fail "the updater does not run the buh-updater image"
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME-updater")" = always ] || fail "the updater is not --restart=always"
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME-proxy")" = always ] || fail "the proxy is not --restart=always"
wait_for 60 "status.json" sh -c "docker exec $NAME cat /updater-status/status.json | grep -q '\"mode\":\"single\"'"

step "3. the proxy"
wait_for 60 "the local CA" docker exec "$NAME-proxy" test -f /data/caddy/pki/authorities/local/root.crt
docker exec "$NAME-proxy" cat /data/caddy/pki/authorities/local/root.crt > "$WORK/ca.crt"
wait_for 60 "https through the proxy" "${C[@]}" -f "https://$DOMAIN/api/health"
[ "$(docker exec "$NAME-proxy" id -u)" = 1000 ] || fail "the proxy runs as root"
docker exec "$NAME-proxy" grep -Eq '^CapEff:[[:space:]]+0000000000000400$' /proc/1/status ||
  fail "the proxy has more than NET_BIND_SERVICE: $(docker exec "$NAME-proxy" grep CapEff /proc/1/status)"
redirect=$("${C[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN/products?x=1")
[ "$redirect" = "308 https://$DOMAIN/products?x=1" ] || fail "HTTP does not redirect to HTTPS: $redirect"
www=$("${C[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "https://www.$DOMAIN/a")
[ "$www" = "301 https://$DOMAIN/a" ] || fail "www does not redirect to the domain: $www"
"${C[@]}" -D "$WORK/headers" -o /dev/null "https://$DOMAIN/"
tr -d '\r' < "$WORK/headers" | tr '[:upper:]' '[:lower:]' > "$WORK/h"
cat "$WORK/h"
head -n 1 "$WORK/h" | grep -q ' 200' || fail "the storefront does not answer 200"
if grep -q '^server:\|^x-powered-by:' "$WORK/h"; then fail "Server or X-Powered-By is sent"; fi
[ "$(grep -c '^strict-transport-security:' "$WORK/h")" = 1 ] || fail "HSTS is not sent exactly once"
[ "$(grep -c '^content-security-policy:' "$WORK/h")" = 1 ] || fail "CSP is not sent exactly once"
if "${C[@]}" -o /dev/null --tls-max 1.1 "https://$DOMAIN/" 2> /dev/null; then fail "TLS 1.1 is accepted"; fi
"${C[@]}" -o /dev/null --tlsv1.2 --tls-max 1.2 -f "https://$DOMAIN/api/health" || fail "TLS 1.2 is refused"

step "4. a visitor cannot forge X-Real-IP"
# Hold the updater's lock (as another updater would), so it leaves the proxy alone meanwhile.
# shellcheck disable=SC2016 # expanded in the container
wait_for 120 "the updater's lock" docker exec "$NAME-updater" sh -c 'mkdir /state/lock && echo "ci-test 1 $(date +%s)" > /state/lock/owner'
docker run -d --pids-limit 256 --name buh-vps-echo -p 127.0.0.1:13999:3000 --entrypoint node buh:test \
  -e "require('http').createServer((q,s)=>{let n=0;q.on('data',c=>n+=c.length);q.on('end',()=>s.end(JSON.stringify({...q.headers,bodyBytes:n})))}).listen(3000)" > /dev/null
docker stop -t 5 "$NAME-proxy" > /dev/null
docker run -d --pids-limit 256 --name buh-vps-echo-proxy --network host --read-only --tmpfs /tmp --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true -v "$NAME-proxy-data:/data" -v "$NAME-proxy-config:/config" \
  -e "DOMAIN=$DOMAIN" -e UPSTREAM=127.0.0.1:13999 -e TLS=internal "$PROXY_REF" > /dev/null
wait_for 60 "the echo proxy" "${C[@]}" -f "https://$DOMAIN/"
seen=$("${C[@]}" -H 'X-Real-IP: 6.6.6.6' "https://$DOMAIN/" | jq -r '."x-real-ip"')
echo "the shop sees X-Real-IP: $seen"
[ "$seen" = 127.0.0.1 ] || fail "X-Real-IP from the visitor was passed on: $seen"
# The body limit (12 MB), on an upstream that reads the whole body.
head -c 13000000 /dev/zero > "$WORK/big"
code=$("${C[@]}" -o /dev/null -w '%{http_code}' -X POST --data-binary "@$WORK/big" "https://$DOMAIN/upload")
[ "$code" = 413 ] || fail "a 13 MB body was not refused (got $code)"
head -c 1000000 /dev/zero > "$WORK/small"
got=$("${C[@]}" -X POST --data-binary "@$WORK/small" "https://$DOMAIN/upload" | jq -r .bodyBytes)
[ "$got" = 1000000 ] || fail "a 1 MB body did not get through (got $got)"
docker rm -f buh-vps-echo-proxy buh-vps-echo > /dev/null
docker start "$NAME-proxy" > /dev/null
docker exec "$NAME-updater" rm -rf /state/lock
wait_for 60 "the proxy again" "${C[@]}" -f "https://$DOMAIN/api/health"

step "5. a version switch of the shop (single mode) under load through the proxy"
docker tag buh:9.1.1 "$LATEST"
start_load
sleep 2
docker exec "$NAME" node -e "const fs=require('fs'),t='/updater-control/.request-ci-'+require('crypto').randomBytes(6).toString('hex');fs.writeFileSync(t,'update\n',{flag:'wx'});fs.linkSync(t,'/updater-control/request');fs.rmSync(t)"
wait_for 300 "the switch" sh -c "docker exec $NAME-updater cat /public/status.json | jq -e '.running == \"9.1.1\" and .lastRequest.result == \"ok\"'"
sleep 3
stop_load
SWITCH_FAILED=$LOAD_FAILED
[ "$(image_of "$NAME")" = "$(id_of buh:9.1.1)" ] || fail "the shop does not run 9.1.1"
[ "$(docker port "$NAME")" = "3000/tcp -> 127.0.0.1:$PORT" ] || fail "the binding changed after the switch"
in_shop SESSION_SECRET "$SECRET"

step "6. the proxy keeps itself up to date (and undoes a broken image)"
docker tag buh-proxy:vps-next "$PROXY_REF"
docker exec "$NAME-updater" touch /state/update-now
wait_for 120 "the new proxy" sh -c "[ \"\$(docker inspect -f '{{.Image}}' $NAME-proxy)\" = '$(id_of buh-proxy:vps-next)' ]"
wait_for 60 "https after the proxy update" "${C[@]}" -f "https://$DOMAIN/api/health"
docker tag buh-proxy:vps-broken "$PROXY_REF"
docker exec "$NAME-updater" touch /state/update-now
wait_for 180 "the broken proxy to be undone" sh -c "docker exec $NAME-updater grep -q 'did not come up' /state/alerts/alerts.log"
wait_for 60 "the proxy back" "${C[@]}" -f "https://$DOMAIN/api/health"
[ "$(image_of "$NAME-proxy")" = "$(id_of buh-proxy:vps-next)" ] || fail "the proxy before was not put back"

step "7. the updater keeps itself up to date (and does not use a broken image)"
docker tag buh-updater:vps-next "$UPDATER_REF"
docker exec "$NAME-updater" touch /state/update-now
wait_for 180 "the updater handover" sh -c "[ \"\$(docker inspect -f '{{.Image}}' $NAME-updater)\" = '$(id_of buh-updater:vps-next)' ]"
wait_for 120 "the old updater to be retired" sh -c "! docker inspect $NAME-updater-old"
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME-updater")" = always ] || fail "the new updater is not --restart=always"
docker tag buh-updater:vps-broken "$UPDATER_REF"
docker exec "$NAME-updater" touch /state/update-now
wait_for 180 "the broken updater to be refused" sh -c "docker exec $NAME-updater grep -q 'newer updater image .* was not used' /state/alerts/alerts.log"
[ "$(image_of "$NAME-updater")" = "$(id_of buh-updater:vps-next)" ] || fail "the running updater changed"
if docker inspect "$NAME-updater-new" > /dev/null 2>&1; then fail "the broken updater was left behind"; fi

step "8. a stopped proxy is started again"
docker stop -t 5 "$NAME-proxy" > /dev/null
wait_for 120 "the proxy restarted by the updater" "${C[@]}" -f "https://$DOMAIN/api/health"

step "updater state"
docker exec "$NAME-updater" updater-status
docker exec "$NAME-updater" cat /state/alerts/alerts.log

echo
echo "failed requests through the proxy during the version switch: $SWITCH_FAILED"
[ "$SWITCH_FAILED" = 0 ] || fail "requests failed during the switch"
echo "set-up and proxy test passed"
