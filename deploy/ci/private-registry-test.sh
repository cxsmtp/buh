#!/usr/bin/env bash
# CI (.github/workflows/zero-downtime.yml): private images, with real containers. A registry
# that requires a login (registry:2 with htpasswd on 127.0.0.1:5098) holds the shop and the
# updater image, as ghcr.io does for this repository:
#
#   1. `setup` without the login folder, then with a wrong login: refused, nothing changed;
#      a login folder the updater cannot read (another user's, mode 700): refused, saying what to do;
#   2. with the login (the folder mounted read-only, as the one-line set-up does): set up; the
#      token is in no output, log or status;
#   3. an update downloads through the login and runs the shop by digest (repo@sha256:…);
#   4. the login expires: the update is refused plainly (alert, status), nothing is marked bad;
#   5. a version that comes back under another digest is refused (critical alert, status);
#   6. a new login (a new file, as `podman login` writes it) works without a restart; the
#      history lists every install with its digest.
#
# Needs buh:test. Against Podman (its API service must read a registries.conf that marks
# 127.0.0.1:5098 insecure, written before the service starts):
#   DOCKER_HOST=unix:///run/podman/podman.sock ENGINE_SOCKET=/run/podman/podman.sock deploy/ci/private-registry-test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=buh-priv
PORT=13100
REG=127.0.0.1:5098
ENGINE_SOCKET=${ENGINE_SOCKET:-/var/run/docker.sock}
REGISTRY_IMAGE=${REGISTRY_IMAGE:-registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373}
HTPASSWD_IMAGE=${HTPASSWD_IMAGE:-httpd:2.4.62-alpine@sha256:88c55a4fcc1df6cf9e7b38360fb6a6feb4d5c5cf5a27a9ff38096ae585af707f}
WORK=$(mktemp -d)
chmod 755 "$WORK"
USER_NAME=owner
TOKEN="ghp_ci$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SHOP=$REG/cxsmtp/buh
UPD=$REG/cxsmtp/buh-updater

step() { printf '\n==== %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  docker ps -a >&2 || true
  docker logs --tail 40 "$NAME-updater" >&2 || true
  exit 1
}
id_of() { docker image inspect -f '{{.Id}}' "$1"; }
image_of() { docker inspect -f '{{.Image}}' "$1"; }
derive() { # derive FROM TAG CHANGE
  local c
  c=$(docker create "$1")
  docker commit --change "$3" "$c" "$2" > /dev/null
  docker rm "$c" > /dev/null
}
cleanup() {
  # Kill first: Podman's rm -f waits out an updater's 600 s stop timeout.
  docker kill "$NAME-updater" "$NAME-updater-new" "$NAME-updater-old" > /dev/null 2>&1 || true
  docker rm -f "$NAME-updater" "$NAME-updater-new" "$NAME-updater-old" "$NAME" "$NAME-previous" "$NAME-candidate" buh-priv-registry > /dev/null 2>&1 || true
  docker volume rm "$NAME-data" "$NAME-updater-state" "$NAME-updater-control" "$NAME-updater-status" > /dev/null 2>&1 || true
  # The updater's tags (shared with the other tests when they run on one machine).
  docker rmi buh:last-good buh:previous > /dev/null 2>&1 || true
  as_root 'rm -rf /l/* /l/.[!.]*' > /dev/null 2>&1 || true
  rm -rf "$WORK" 2> /dev/null || true
}
cleanup
trap cleanup EXIT
mkdir -p "$WORK/login" "$WORK/push" "$WORK/auth"
chmod 700 "$WORK/push"
# The login folder as a root engine has it (/root/.config/containers: root's, 700; auth.json
# 600), so through a container: this script need not run as root. as_root SCRIPT (stdin passed).
as_root() {
  docker run --rm -i --pids-limit 64 --network none -v "$WORK/login:/l" --entrypoint sh "$HTPASSWD_IMAGE" -c "$1"
}
login_json() { printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REG" "$(printf '%s:%s' "$USER_NAME" "$1" | base64 | tr -d '\n')"; }
write_login() { # write_login PASSWORD: replaced as a new file, as podman login does
  login_json "$1" | as_root 'cat > /l/.auth.json.new && chmod 600 /l/.auth.json.new && mv -f /l/.auth.json.new /l/auth.json && chown -R 0:0 /l && chmod 700 /l' ||
    fail "could not write the login"
}
updater() { docker exec "$NAME-updater" "$@"; }
status_json() { updater cat /public/status.json; }
wait_status() { # wait_status TEXT: until a daemon round has published it (up to 30 s)
  for _ in $(seq 1 30); do
    if status_json 2> /dev/null | grep -qF "$1"; then return 0; fi
    sleep 1
  done
  return 1
}

step "a registry that requires a login; the shop (9.3.0, 9.3.1) and the updater pushed to it"
docker image inspect buh:test > /dev/null || fail "build buh:test first"
docker run --rm --pids-limit 64 --entrypoint htpasswd "$HTPASSWD_IMAGE" -Bbn "$USER_NAME" "$TOKEN" > "$WORK/auth/htpasswd"
# On the host network (Podman forwards a port published on 127.0.0.1 only to some callers);
# --pids-limit: through the docker CLI, Podman reads "no limit" as 0 on some hosts.
docker run -d --name buh-priv-registry --pids-limit 256 --network host -e "REGISTRY_HTTP_ADDR=$REG" -v "$WORK/auth:/auth:ro" -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=buh -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd "$REGISTRY_IMAGE" > /dev/null
for _ in $(seq 1 30); do
  [ "$(curl --noproxy '*' -s --max-time 5 -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = 401 ] && break
  sleep 1
done
login_json "$TOKEN" > "$WORK/push/config.json"
push() { DOCKER_CONFIG="$WORK/push" docker push -q "$1" > /dev/null || fail "push $1"; }
derive buh:test "$SHOP:9.3.0" 'LABEL org.opencontainers.image.version=9.3.0'
derive buh:test "$SHOP:9.3.1" 'LABEL org.opencontainers.image.version=9.3.1'
derive buh:test "$SHOP:9.3.1-other" 'LABEL org.opencontainers.image.version=9.3.1
LABEL ci.other=1'
derive buh:test "$SHOP:9.3.2" 'LABEL org.opencontainers.image.version=9.3.2'
# PREBUILT=1: the updater image is already there as buh-updater:vps-latest (e.g. built with podman build).
if [ "${PREBUILT:-0}" = 1 ]; then
  docker tag buh-updater:vps-latest "$UPD:latest"
else
  docker build -q -f deploy/updater/Dockerfile -t "$UPD:latest" . > /dev/null
fi
docker tag "$SHOP:9.3.0" "$SHOP:latest"
for ref in "$SHOP:9.3.0" "$SHOP:latest" "$UPD:latest"; do push "$ref"; done
as_root 'chown 0:0 /l && chmod 700 /l'

step "1. the owner's shop (9.3.0), then setup without the login folder, and with a wrong login"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -v "$NAME-data:/data" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 2048 -e TZ=Asia/Dubai "$SHOP:9.3.0" > /dev/null
for _ in $(seq 1 90); do curl --noproxy '*' -sf --max-time 10 "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 1; done
shop_cid=$(docker inspect -f '{{.Id}}' "$NAME")
setup() { # setup [extra run args…]: the one-line set-up (the updater image from this computer)
  docker run --rm --pids-limit 128 --security-opt label=disable -v "$ENGINE_SOCKET:/var/run/docker.sock" -e "SOCK=$ENGINE_SOCKET" \
    -e HEAL_CHECK_SECONDS=3 -e SELF_CHECK_SECONDS=5 "$@" "$UPD:latest" setup "$NAME" --image "$SHOP:latest" --minutes 0
}
out=$(setup 2>&1) && fail "setup without a login passed: $out"
grep -q "refused to send .*: no valid login" <<< "$out" || fail "unclear refusal: $out"
grep -q "did not pass Podman's login folder" <<< "$out" || fail "no hint about the folder: $out"
write_login "wrong-token"
out=$(setup -v "$WORK/login:/run/buh/registry-auth:ro" 2>&1) && fail "setup with a wrong login passed: $out"
grep -q "no valid login" <<< "$out" || fail "unclear refusal: $out"
# The right login in a folder the updater cannot read (another user's, 700): said plainly, up front.
write_login "$TOKEN"
as_root 'chown -R 1000:1000 /l'
out=$(setup -v "$WORK/login:/run/buh/registry-auth:ro" 2>&1) && fail "setup with an unreadable login folder passed: $out"
grep -q "the updater cannot read the registry login folder $WORK/login: .*must belong to the user Podman runs as. On a Linux server (Podman as root): chown -R root:root $WORK/login && chmod 700 $WORK/login" <<< "$out" ||
  fail "unclear refusal for an unreadable folder: $out"
grep -q "Nothing was changed" <<< "$out" || fail "no word that nothing changed: $out"
as_root 'chown -R 0:0 /l'
[ "$(docker inspect -f '{{.Id}}' "$NAME")" = "$shop_cid" ] || fail "the shop was changed by a refused set-up"
if docker inspect "$NAME-updater" > /dev/null 2>&1; then fail "an updater was started by a refused set-up"; fi

step "2. with the login: set up"
write_login "$TOKEN"
out=$(setup -v "$WORK/login:/run/buh/registry-auth:ro" 2>&1) || fail "setup failed: $out"
printf '%s\n' "$out" | tail -n 5
grep -q 'Done. Automatic updates are on' <<< "$out" || fail "no summary"
docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$NAME-updater" | grep -qx "$WORK/login|/run/buh/registry-auth|false" ||
  fail "the updater does not have the login folder read-only: $(docker inspect -f '{{json .Mounts}}' "$NAME-updater")"
for _ in $(seq 1 60); do
  [ "$(updater readlink /state/docker-config/config.json 2> /dev/null)" = /run/buh/registry-auth/auth.json ] && break
  sleep 1
done
# shellcheck disable=SC2016 # expanded in the container
[ "$(updater readlink /state/docker-config/config.json)" = /run/buh/registry-auth/auth.json ] ||
  fail "the CLI does not use the login: $(updater sh -c 'echo "DOCKER_CONFIG=$DOCKER_CONFIG"; id; ls -la /state/docker-config /run/buh/registry-auth; tail -n 5 /state/updater.log' 2>&1)"

step "3. an update through the login; the shop runs by digest"
docker tag "$SHOP:9.3.1" "$SHOP:latest"
push "$SHOP:latest"
updater update-now > /dev/null || fail "update-now failed: $(updater tail -n 20 /state/updater.log)"
[ "$(image_of "$NAME")" = "$(id_of "$SHOP:9.3.1")" ] || fail "the shop does not run 9.3.1"
run_ref=$(docker inspect -f '{{.Config.Image}}' "$NAME")
echo "the shop runs as: $run_ref"
docker ps --filter "name=^$NAME\$" --format '{{.Names}}  {{.Image}}'
[[ $run_ref == "$SHOP@sha256:"* ]] || fail "not started by digest: $run_ref"
updater cat /state/version-digests

step "3b. the folder later belongs to someone else: each check says what to do"
as_root 'chown -R 1000:1000 /l'
updater update-now > /dev/null 2>&1 || true
updater grep -q 'cannot read the registry login folder' /state/alerts/alerts.log || fail "no alert for an unreadable folder: $(updater tail -n 5 /state/updater.log)"
wait_status '"registryProblem":"the updater cannot read the registry login folder' || fail "no note in the status: $(status_json)"
as_root 'chown -R 0:0 /l'
[ "$(image_of "$NAME")" = "$(id_of "$SHOP:9.3.1")" ] || fail "the shop changed"

step "4. the login expires: refused plainly, nothing marked bad"
write_login "expired-token"
docker tag "$SHOP:9.3.2" "$SHOP:latest"
push "$SHOP:latest"
rc=0
updater update-now > /dev/null 2>&1 || rc=$?
[ "$rc" = 3 ] || fail "update-now with an expired login: exit $rc, not 3"
updater grep -q 'registry login has expired or is missing' /state/alerts/alerts.log || fail "no alert"
wait_status '"registryProblem":"the registry login has expired' || fail "no note in the status: $(status_json)"
[ "$(image_of "$NAME")" = "$(id_of "$SHOP:9.3.1")" ] || fail "the shop changed"
if updater test -s /state/bad-images; then fail "an image was marked bad for a login problem"; fi

step "5. 9.3.1 comes back under another digest: refused"
write_login "$TOKEN"
docker tag "$SHOP:9.3.1-other" "$SHOP:latest"
push "$SHOP:latest"
rc=0
updater update-now > /dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "a changed 9.3.1 was not refused (exit $rc)"
updater grep -q '"level":"critical".*version 9.3.1 is published under another digest' /state/alerts/alerts.log || fail "no critical alert"
wait_status '"integrityProblem":"Version 9.3.1 was refused' || fail "no warning in the status: $(status_json)"
[ "$(image_of "$NAME")" = "$(id_of "$SHOP:9.3.1")" ] || fail "the shop changed"

step "6. a proper new version with the new login: installed; the history"
docker tag "$SHOP:9.3.2" "$SHOP:latest"
push "$SHOP:latest"
updater update-now > /dev/null || fail "update-now failed"
[ "$(image_of "$NAME")" = "$(id_of "$SHOP:9.3.2")" ] || fail "the shop does not run 9.3.2"
wait_status '"registryProblem":""' || fail "the login note stayed"
updater cat /state/install-history
[ "$(updater grep -c ' sha256:' /state/install-history)" -ge 2 ] || fail "the history lacks the digests"
wait_status '","version":"9.3.2","digest":"sha256:' || fail "the status lacks the history: $(status_json)"
status_json | grep -q '"history":\[{"at":"[^"]*","version":"9.3.2","digest":"sha256:' || fail "the newest install is not first: $(status_json)"
status_json | grep -q '"integrityProblem":""' || fail "the warning stayed after a good install"

step "the token is in no output, log or status"
for text in "$out" "$(docker logs "$NAME-updater" 2>&1)" "$(updater cat /state/updater.log)" "$(status_json)" "$(updater cat /state/alerts/alerts.log)"; do
  if grep -qF -e "$TOKEN" -e "$(printf '%s:%s' "$USER_NAME" "$TOKEN" | base64 | tr -d '\n')" <<< "$text"; then fail "the token leaked"; fi
done
echo
echo "private registry test passed"
