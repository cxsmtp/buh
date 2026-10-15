#!/usr/bin/env bash
# CI only (.github/workflows/zero-downtime.yml): proves the blue/green updater against
# real containers. Needs the image buh:test (the shop, built from this commit).
#
#   1. start app-blue + Caddy (plain http :8080) from docker-compose.yml;
#   2. good image (buh:test with another label, so a different digest), under load:
#      zero failed requests, and app-green serves afterwards;
#   3. broken images (exits at once; answers 503 everywhere), under load: zero failed
#      requests, the old copy keeps serving, buh:last-good unchanged, not retried;
#   4. a second good image switches back (green → blue), under load;
#   5. the database snapshot was taken, also the fallback for images without the script;
#   6. self-healing: with no copy running, one is started from buh:last-good.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f docker-compose.yml -f deploy/ci/compose.ci.yml)
URL=http://127.0.0.1:8080
LOAD_DIR=$(mktemp -d)

step() { printf '\n==== %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

cid_of() { docker ps -q --filter "label=com.docker.compose.service=app-$1" --filter "label=com.docker.compose.oneoff=False"; }
image_of() { docker inspect -f '{{.Image}}' "$1"; }
id_of() { docker image inspect -f '{{.Id}}' "$1"; }

updater() { # updater IMAGE [command]: one run of deploy/updater/updater.sh as the compose service
  local image=$1
  shift
  "${COMPOSE[@]}" --profile autoupdate run --rm -T -e IMAGE="$image" -e SETTLE_SECONDS=8 updater "${@:-once}"
}

# Four clients hitting the storefront, the health check and the catalogue through Caddy.
start_load() {
  rm -f "$LOAD_DIR"/codes.* "$LOAD_DIR/stop"
  for n in 1 2 3 4; do
    (
      while [ ! -f "$LOAD_DIR/stop" ]; do
        for p in / /api/health /api/products; do
          curl -s -o /dev/null --max-time 60 -w "%{http_code} %{time_total}s $p\n" "$URL$p" >> "$LOAD_DIR/codes.$n" || true
        done
      done
    ) &
  done
}

stop_load() {
  touch "$LOAD_DIR/stop"
  wait
  local total failed
  total=$(cat "$LOAD_DIR"/codes.* | wc -l)
  failed=$(cat "$LOAD_DIR"/codes.* | grep -vc '^200 ' || true)
  echo "requests during the switch: $total, failed: $failed, slowest: $(sort -k2 -g "$LOAD_DIR"/codes.* | tail -n 1)"
  [ "$total" -ge 50 ] || fail "too few requests ($total) to prove anything"
  if [ "$failed" != 0 ]; then
    grep -hv '^200 ' "$LOAD_DIR"/codes.* | sort | uniq -c >&2
    fail "$failed requests failed during the switch"
  fi
}

serves() {
  curl -sf --max-time 30 "$URL/api/health" | grep -q '"ok":true' || fail "the shop does not answer through Caddy"
  curl -sf --max-time 30 "$URL/" | grep -q '<html' || fail "the storefront does not render through Caddy"
}

step "images: good (new label = new digest), crashing, unhealthy"
docker commit --change 'LABEL ci.revision=good-1' "$(docker create buh:test)" buh:ci-good > /dev/null
docker commit --change 'LABEL ci.revision=good-2' "$(docker create buh:test)" buh:ci-good2 > /dev/null
docker commit --change 'CMD ["node","-e","process.exit(1)"]' "$(docker create buh:test)" buh:ci-crash > /dev/null
docker commit --change 'CMD ["node","-e","require(\"http\").createServer((q,s)=>{s.statusCode=503;s.end()}).listen(3000)"]' \
  "$(docker create buh:test)" buh:ci-unhealthy > /dev/null
for i in test ci-good ci-good2 ci-crash ci-unhealthy; do echo "buh:$i $(id_of "buh:$i")"; done
[ "$(id_of buh:ci-good)" != "$(id_of buh:test)" ] || fail "the good image must have a different digest"

step "start app-blue (buh:test) and Caddy"
BUH_IMAGE=buh:test "${COMPOSE[@]}" up -d app-blue caddy
for _ in $(seq 1 90); do
  if curl -sf --max-time 5 "$URL/api/health" > /dev/null; then break; fi
  sleep 1
done
serves
[ -n "$(cid_of blue)" ] || fail "app-blue is not running"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cid_of blue)")" = healthy ] && break
  sleep 1
done

step "first updater run: records the running image as last good, nothing to update"
updater buh:test
[ "$(id_of buh:last-good)" = "$(id_of buh:test)" ] || fail "buh:last-good was not recorded"

step "(a) good image, blue → green, under load"
start_load
sleep 3
updater buh:ci-good
sleep 3
stop_load
[ -n "$(cid_of green)" ] || fail "app-green is not running"
[ -z "$(cid_of blue)" ] || fail "app-blue is still running"
[ "$(image_of "$(cid_of green)")" = "$(id_of buh:ci-good)" ] || fail "app-green does not run the new image"
[ "$(id_of buh:last-good)" = "$(id_of buh:ci-good)" ] || fail "buh:last-good did not move to the new image"
[ "$(id_of buh:previous)" = "$(id_of buh:test)" ] || fail "buh:previous is not the old image"
serves

for broken in ci-crash ci-unhealthy; do
  step "(b) broken image buh:$broken, under load: the old copy keeps serving"
  start_load
  sleep 3
  rc=0
  updater "buh:$broken" || rc=$?
  sleep 3
  stop_load
  [ "$rc" = 1 ] || fail "the updater should report a failed update (exit 1), got $rc"
  [ -n "$(cid_of green)" ] || fail "app-green (the old copy) stopped"
  [ "$(image_of "$(cid_of green)")" = "$(id_of buh:ci-good)" ] || fail "app-green changed image"
  [ -z "$(docker ps -aq --filter label=com.docker.compose.service=app-blue)" ] || fail "the broken app-blue was not removed"
  [ "$(id_of buh:last-good)" = "$(id_of buh:ci-good)" ] || fail "buh:last-good changed"
  serves
done

step "(b) the same broken image again is skipped"
updater buh:ci-crash | tee "$LOAD_DIR/skip.log"
grep -q 'failed before' "$LOAD_DIR/skip.log" || fail "a rejected image was retried"
[ -z "$(docker ps -aq --filter label=com.docker.compose.service=app-blue)" ] || fail "a rejected image was started"

step "(a) second good image, green → blue, under load"
start_load
sleep 3
updater buh:ci-good2
sleep 3
stop_load
[ -n "$(cid_of blue)" ] || fail "app-blue is not running"
[ -z "$(cid_of green)" ] || fail "app-green is still running"
[ "$(image_of "$(cid_of blue)")" = "$(id_of buh:ci-good2)" ] || fail "app-blue does not run the second image"
serves

step "database snapshots before each switch, and the fallback for older images"
docker exec "$(cid_of blue)" ls -l /data/backups
[ "$(docker exec "$(cid_of blue)" sh -c 'ls /data/backups/pre-update-*.db | wc -l')" -ge 2 ] || fail "no pre-update snapshots"
docker exec -i "$(cid_of blue)" node --input-type=module - < scripts/backup-now.mjs | grep -q pre-update- || fail "backup-now.mjs fed on stdin did not run"

step "alerts are in the shop's volume, readable by the shop"
docker exec "$(cid_of blue)" cat /data/updater/alerts.log
docker exec "$(cid_of blue)" grep -q '"level":"error"' /data/updater/alerts.log || fail "no alert for the broken images"

step "self-healing: nothing running → started from buh:last-good"
docker stop -t 25 "$(cid_of blue)"
updater buh:ci-good2 heal
[ -n "$(cid_of blue)$(cid_of green)" ] || fail "nothing was started"
serves

step "updater state"
updater buh:ci-good2 status

echo
echo "zero-downtime test passed"
