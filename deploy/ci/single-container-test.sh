#!/usr/bin/env bash
# CI (.github/workflows/zero-downtime.yml): proves the updater's single-container mode
# (UPDATER_MODE=single, the Podman-on-Windows set-up) against real containers, driven the way
# scripts/podman-autoupdate.bat drives it: the docker CLI image talking to the engine's socket.
# Needs the image buh:test (the shop, built from this commit). In CI Docker stands in for
# Podman; to run it against Podman's Docker-compatible API instead:
#   DOCKER_HOST=unix:///run/podman/podman.sock ENGINE_SOCKET=/run/podman/podman.sock deploy/ci/single-container-test.sh
#
#   1. the owner's hand-started container (port, data volume, no updater volumes);
#   2. adopt refuses another data volume; then re-creates the container with the updater's
#      volumes, same image and same data;
#   3. the daemon publishes its status (mode single), which the shop reads;
#   4. "update" from the shop's request folder (written as the shop's user): the new image is
#      tried without a port, then replaces the shop; the pause is measured and reported;
#   5. broken images (exit at once; answer 503): the shop never stops, zero failed requests;
#   6. an image that passes its trial but fails as the real container: the previous one is back;
#   7. "rollback X.Y.Z" from the request folder;
#   8. self-healing: a stopped shop is started again; a removed one is re-created on the same data.
set -euo pipefail

cd "$(dirname "$0")/../.."
NAME=buh-single
PORT=18081
VOLUME=buh-single-data
CONTROL=$NAME-updater-control
STATUS=$NAME-updater-status
STATE=$NAME-updater-state
CODE=$NAME-updater-code
UPDATER=$NAME-updater
UPDATER_IMAGE=docker:27.3.1-cli
# The engine's API socket on this machine, mounted into the updater as /var/run/docker.sock.
ENGINE_SOCKET=${ENGINE_SOCKET:-/var/run/docker.sock}
LATEST=buh:ci-latest
URL=http://127.0.0.1:$PORT
WORK=$(mktemp -d)

step() { printf '\n==== %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  docker ps -a >&2 || true
  docker logs --tail 50 "$UPDATER" >&2 || true
  docker logs --tail 30 "$NAME" >&2 || true
  exit 1
}
id_of() { docker image inspect -f '{{.Id}}' "$1"; }
image_of() { docker inspect -f '{{.Image}}' "$1"; }
started_at() { docker inspect -f '{{.State.StartedAt}}' "$1"; }

cleanup() {
  docker rm -f "$UPDATER" "$NAME" "$NAME-candidate" "$NAME-previous" > /dev/null 2>&1 || true
  docker volume rm "$VOLUME" "$CONTROL" "$STATUS" "$STATE" "$CODE" buh-single-other > /dev/null 2>&1 || true
  # The updater's tags (shared with the blue/green test when both run on one machine).
  docker rmi buh:last-good buh:previous "$LATEST" > /dev/null 2>&1 || true
}
cleanup
trap 'touch "$WORK/stop"; cleanup' EXIT

# The updater's settings, as scripts/podman-autoupdate.bat passes them.
UPD=(--security-opt label=disable -v "$ENGINE_SOCKET:/var/run/docker.sock" -v "$CODE:/updater:ro" -v "$STATE:/state"
  -v "$CONTROL:/control" -v "$STATUS:/public"
  -e UPDATER_MODE=single -e "SHOP_NAME=$NAME" -e "SHOP_PORT=$PORT" -e "SHOP_VOLUME=$VOLUME" -e "CONTROL_VOLUME=$CONTROL" -e "STATUS_VOLUME=$STATUS"
  -e "IMAGE=$LATEST" -e UPDATE_CHECK_MINUTES=0 -e HOME=/tmp -e DOCKER_CONFIG=/state/docker-config
  -e PATH=/updater/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  -e "SHOP_ENV=TZ=Asia/Dubai NEXT_PUBLIC_SUPPORT_EMAIL=help@ci.example" -e HEAL_CHECK_SECONDS=3 -e HEALTH_TIMEOUT=90
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --entrypoint /bin/sh)
updater_once() { # updater_once COMMAND [more docker run options]: one run, as the .bat's set-up step
  local cmd=$1
  shift
  docker run --rm "${UPD[@]}" "$@" "$UPDATER_IMAGE" /updater/updater.sh "$cmd"
}

status_json() { docker exec "$UPDATER" cat /public/status.json 2> /dev/null || echo '{}'; }
wait_for() { # wait_for SECONDS DESCRIPTION COMMAND...
  local limit=$1 what=$2
  shift 2
  for _ in $(seq 1 "$limit"); do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for: $what (status: $(status_json))"
}
request_done() { # request_done REQUEST RESULT: the answer to the last ask (not to an earlier one)
  local s
  s=$(status_json)
  [ "$(jq -r .lastRequest.at <<< "$s")" != "$ASKED_AFTER" ] &&
    [ "$(jq -r .lastRequest.request <<< "$s")" = "$1" ] && [ "$(jq -r .lastRequest.result <<< "$s")" = "$2" ]
}
ask() { # ask LINE: the request, written the way the shop writes it (new file, as user 1001)
  ASKED_AFTER=$(status_json | jq -r .lastRequest.at)
  sleep 1 # the status gives the time to the second
  docker exec "$NAME" node -e "require('fs').writeFileSync('/updater-control/request', process.argv[1] + '\n', { flag: 'wx', mode: 0o644 })" "$1"
}
serves() {
  curl -sf --max-time 30 "$URL/api/health" | grep -q '"ok":true' || fail "the shop does not answer on port $PORT"
  curl -sf --max-time 30 "$URL/" | grep -q '<html' || fail "the storefront does not render"
}
data_kept() {
  docker exec "$NAME" test -f /data/ci-marker || fail "the data volume changed: /data/ci-marker is gone"
}

# Health checks every 0.2 s on the port: failed requests and the longest gap without an answer.
start_load() {
  rm -f "$WORK/stop" "$WORK/load"
  (
    while [ ! -f "$WORK/stop" ]; do
      code=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$URL/api/health" || true)
      printf '%s %s\n' "$(date +%s.%N)" "$code" >> "$WORK/load"
      sleep 0.2
    done
  ) &
  LOAD_PID=$!
}
stop_load() { # stop_load MAX_FAILED: prints the numbers, fails above MAX_FAILED
  touch "$WORK/stop"
  wait "$LOAD_PID" || true
  local total failed gap
  total=$(wc -l < "$WORK/load")
  failed=$(grep -vc ' 200$' "$WORK/load" || true)
  # The longest time between two answers (includes the 0.2 s between checks).
  gap=$(awk '$2 == 200 { if (prev) { d = $1 - prev; if (d > max) max = d } prev = $1 } END { printf "%.1f", max + 0 }' "$WORK/load")
  echo "requests: $total, failed: $failed, longest time without an answer: ${gap}s"
  [ "$total" -ge 20 ] || fail "too few requests ($total) to prove anything"
  [ "$failed" -le "$1" ] || fail "$failed requests failed (at most $1 allowed)"
  LAST_GAP=$gap
}

step "images: good (two versions), crashing, unhealthy, fails only as the second start"
docker image inspect buh:test > /dev/null || fail "build buh:test first"
docker run --rm --pids-limit 64 --entrypoint sh buh:test -c 'test -f /app/updater/updater.sh' || fail "the image does not carry the updater (Dockerfile)"
derive() { # derive FROM TAG CHANGE: an image from FROM with one Dockerfile change
  local c
  c=$(docker create "$1")
  docker commit --change "$3" "$c" "$2" > /dev/null
  docker rm "$c" > /dev/null
}
derive buh:test buh:9.0.1 'LABEL org.opencontainers.image.version=9.0.1'
derive buh:test buh:9.0.2 'LABEL org.opencontainers.image.version=9.0.2'
derive buh:test buh:ci-crash 'CMD ["node","-e","process.exit(1)"]'
derive buh:test buh:ci-unhealthy 'CMD ["node","-e","require(\"http\").createServer((q,s)=>{s.statusCode=503;s.end()}).listen(3000)"]'
# Passes its trial (first start), then exits as the real container (second start on the same data).
derive buh:9.0.2 buh:ci-second-fails \
  'CMD ["node","-e","const fs=require(\"fs\"),m=\"/data/ci-second\";if(fs.existsSync(m)){fs.unlinkSync(m);process.exit(1)}fs.writeFileSync(m,\"\");require(\"/app/server.js\")"]'
docker tag buh:9.0.1 "$LATEST"

step "1. the owner's container, started by hand"
docker run -d --name "$NAME" -p "$PORT:3000" -v "$VOLUME:/data" -e TZ=Asia/Dubai -e NEXT_PUBLIC_SUPPORT_EMAIL=help@ci.example \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 2048 buh:9.0.1 > /dev/null
wait_for 90 "the hand-started shop" curl -sf "$URL/api/health"
docker exec "$NAME" node -e "require('fs').writeFileSync('/data/ci-marker', 'x')"
serves

step "2. set-up as the .bat does it: volumes, updater code out of the image, adopt"
for v in "$CONTROL" "$STATUS" "$STATE" "$CODE"; do docker volume create "$v" > /dev/null; done
docker run --rm --pids-limit 64 --user 0 -v "$CONTROL:/c" -v "$STATUS:/s" --entrypoint /bin/sh "$UPDATER_IMAGE" -c 'chown 0:0 /c /s && chmod 1733 /c && chmod 755 /s'
docker run --rm --pids-limit 64 --user 0 -v "$CODE:/out" --entrypoint /bin/sh buh:test -c 'test -f /app/updater/updater.sh && rm -rf /out/* && cp -R /app/updater/. /out/ && chmod -R a+rX /out'

before=$(started_at "$NAME")
rc=0
updater_once adopt -e SHOP_VOLUME=buh-single-other > "$WORK/refused.log" 2>&1 || rc=$?
cat "$WORK/refused.log"
[ "$rc" = 2 ] || fail "adopt with another data volume should refuse (exit 2), got $rc"
grep -q "keeps its data in the volume $VOLUME" "$WORK/refused.log" || fail "the refusal does not say which volume it found"
[ "$(started_at "$NAME")" = "$before" ] || fail "the refused adopt touched the container"
if docker volume inspect buh-single-other > /dev/null 2>&1; then fail "a new data volume was created"; fi

start_load
updater_once adopt
stop_load 1000
echo "adopt closed the shop for about ${LAST_GAP}s"
serves
data_kept
docker inspect -f '{{range .Mounts}}{{.Destination}}={{.Name}} {{end}}' "$NAME" | tee "$WORK/mounts"
grep -q "/updater-control=$CONTROL" "$WORK/mounts" || fail "the request volume is not mounted"
grep -q "/updater-status=$STATUS" "$WORK/mounts" || fail "the status volume is not mounted"
hardening=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}}' "$NAME")
[ "$hardening" = "true 512" ] || fail "read-only / pids limit missing: $hardening"
# What the process really has (engines list dropped capabilities differently): none, and no new ones.
docker exec "$NAME" grep -Eq '^CapEff:[[:space:]]+0+$' /proc/1/status || fail "the shop has capabilities: $(docker exec "$NAME" grep Cap /proc/1/status)"
docker exec "$NAME" grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/1/status || fail "no-new-privileges is missing"
docker exec "$NAME" printenv TZ | grep -qx Asia/Dubai || fail "SHOP_ENV did not reach the shop"
updater_once adopt | grep -q 'nothing to change' || fail "a second adopt should change nothing"

step "3. the updater daemon (--restart=always), its status read by the shop"
docker run -d --name "$UPDATER" --restart=always --stop-timeout 180 "${UPD[@]}" "$UPDATER_IMAGE" /updater/updater.sh daemon > /dev/null
wait_for 60 "status.json" sh -c "docker exec $NAME cat /updater-status/status.json | jq -e '.mode == \"single\" and .running == \"9.0.1\"'"
if docker exec "$NAME" ls /updater-control > /dev/null 2>&1; then fail "the shop can list the request folder"; fi

step "4. update to the latest (9.0.2) from the shop's request folder, under load"
docker tag buh:9.0.2 "$LATEST"
start_load
ask update
wait_for 240 "the update" request_done update ok
stop_load 1000
echo "the switch closed the shop for about ${LAST_GAP}s (allowed: 30s)"
awk -v g="$LAST_GAP" 'BEGIN { exit !(g < 30) }' || fail "the shop was closed for ${LAST_GAP}s"
[ "$(image_of "$NAME")" = "$(id_of buh:9.0.2)" ] || fail "the shop does not run 9.0.2"
[ "$(image_of "$NAME-previous")" = "$(id_of buh:9.0.1)" ] || fail "the previous container is not kept"
[ "$(docker inspect -f '{{.State.Status}}' "$NAME-previous")" = exited ] || fail "the previous container still runs"
if docker inspect "$NAME-candidate" > /dev/null 2>&1; then fail "the trial container was left behind"; fi
serves
data_kept

for broken in ci-crash ci-unhealthy; do
  step "5. broken image buh:$broken, under load: the shop never stops"
  docker tag "buh:$broken" "$LATEST"
  before=$(started_at "$NAME")
  start_load
  ask update
  wait_for 240 "the failed update" request_done update failed
  stop_load 0
  [ "$(started_at "$NAME")" = "$before" ] || fail "the shop was restarted"
  [ "$(image_of "$NAME")" = "$(id_of buh:9.0.2)" ] || fail "the shop changed image"
  if docker inspect "$NAME-candidate" > /dev/null 2>&1; then fail "the broken trial container was left behind"; fi
  serves
done

step "6. passes its trial, fails as the real container: the previous one is back on the port"
docker tag buh:ci-second-fails "$LATEST"
start_load
ask update
wait_for 240 "the failed takeover" request_done update failed
stop_load 1000
[ "$(image_of "$NAME")" = "$(id_of buh:9.0.2)" ] || fail "the previous version is not back"
serves
data_kept
docker exec "$UPDATER" cat /state/alerts/alerts.log | grep -q 'previous container is back' || fail "no alert for the failed takeover"

step "7. rollback 9.0.1 from the request folder"
ask "rollback 9.0.1"
wait_for 240 "the rollback" request_done "rollback 9.0.1" ok
[ "$(image_of "$NAME")" = "$(id_of buh:9.0.1)" ] || fail "the shop does not run 9.0.1"
serves
data_kept

step "8. self-healing: a stopped shop is started again; a removed one is re-created on the same data"
docker stop -t 25 "$NAME" > /dev/null
wait_for 120 "the restart" curl -sf "$URL/api/health"
docker rm -f "$NAME" > /dev/null
wait_for 120 "the re-created shop" curl -sf "$URL/api/health"
serves
data_kept
[ "$(image_of "$NAME")" = "$(id_of buh:9.0.1)" ] || fail "not re-created from the last good image"

step "updater state"
docker exec "$UPDATER" updater-status
docker exec "$UPDATER" cat /state/alerts/alerts.log

echo
echo "single-container test passed"
