#!/bin/sh
# Beautiful UAE Home: blue/green updater with automatic rollback and self-healing.
#
# Runs as the optional `updater` service in docker-compose.yml (profile "autoupdate").
# The shop runs as app-blue or app-green; Caddy sends traffic to the first healthy one
# and retries on the other while they switch, so an update never takes the shop down:
#
#   1. pull the image; if it differs from the one running (and has not failed before):
#   2. snapshot the database (scripts/backup-now.mjs, inside the running copy);
#   3. start the idle colour with the new image and wait until it is healthy and its
#      home page answers;
#   4. healthy: tag it buh:last-good (the one before stays as buh:previous), give Caddy
#      a moment to see it, then stop the old copy gracefully;
#      not healthy: remove it, keep the old copy serving, remember the image as bad (it is
#      not tried again until a newer one is published) and raise an alert.
#
# Self-healing, every HEAL_CHECK_SECONDS: a copy that is unhealthy for UNHEALTHY_LIMIT
# checks in a row is restarted; if that does not help, the other colour is started from
# buh:last-good and takes over. If no copy runs at all, one is started from buh:last-good.
#
# Commands (the compose service runs `daemon`):
#   daemon            loop: heal every HEAL_CHECK_SECONDS, update every UPDATE_CHECK_MINUTES
#   once | update-now heal, then update once, and exit (0 updated/up to date, 1 failed, 2 error)
#   heal              one self-healing check, and exit
#   rollback [image]  switch to buh:previous (or the image given) the same zero-downtime way
#   status            what runs, the last good image, rejected images, recent log
#   adopt             single mode only: set up the shop container (see below)
#
# From the Admin Hub (Settings → System → Versions): the shop writes one line to
# $CONTROL_DIR/request ("rollback 2.0.1" or "update"); the daemon checks it strictly, deletes
# it, acts, and writes what runs and what happened to $PUBLIC_DIR/status.json, which the shop
# reads (read-only). Neither folder holds anything of the updater's own state.
#
# Settings: UPDATE_CHECK_MINUTES (default 15; 0 = only on demand) and ALERT_WEBHOOK_URL are
# read from the environment, else from .env.production (only those two keys).
# Test/CI overrides (environment only): IMAGE, ONE_SHOT=1, HEALTH_TIMEOUT, SETTLE_SECONDS,
# HEAL_CHECK_SECONDS, UNHEALTHY_LIMIT, STOP_TIMEOUT.
#
# ── Single-container mode (UPDATER_MODE=single): one shop container, e.g. Podman on Windows ──
#
# No Caddy and no second copy: the shop is one container with the host port, started by
# this script from a fixed definition (run_shop): SHOP_NAME (default beautifuluaehome) on
# SHOP_PORT (443) -> 3000, data in the volume SHOP_VOLUME (beautifuluaehome-data), the
# request and status volumes CONTROL_VOLUME / STATUS_VOLUME at /updater-control and
# /updater-status (read-only), extra KEY=VALUE pairs from SHOP_ENV (default TZ=Asia/Dubai),
# and always --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true
# --pids-limit 512.
# Every value is checked strictly before anything runs (check_single_settings).
# The docker CLI talks to Podman's Docker-compatible socket (mounted as /var/run/docker.sock).
#
# A switch: pull; snapshot; start the new image as SHOP_NAME-candidate (no port) on the same
# data and check /api/health and the home page from inside it; only then stop SHOP_NAME
# gracefully, keep it as SHOP_NAME-previous, and start the new one with the port and check
# again. On any failure the new container is removed, the previous one is put back on the
# port, the image is remembered as bad, and an alert is raised. The shop is closed for the
# few seconds between stopping the old container and the new one answering.
# Self-healing: a stopped shop container is started again (else re-created from the last
# good image); one that stops answering is restarted, then re-created from the last good image.
# Health is asked of the app itself (node inside the container), not of the engine's
# healthcheck, which Podman runs only where systemd timers are available.
# `adopt` (run once by scripts/podman-autoupdate.bat) re-creates an existing shop container
# with this definition, keeping its image, data volume, port bindings and its own settings
# (env, carried in a root-only env file); it refuses a container whose data lives anywhere
# but SHOP_VOLUME, or that has anything it cannot carry (another mount, another port). The
# self-healing check does the same for a shop container started by hand while it runs.
# Nothing is started while another running container uses SHOP_VOLUME.
set -u
# Character ranges in patterns mean ASCII only.
LC_ALL=C
export LC_ALL

PROJECT_DIR=${PROJECT_DIR:-/project}
STATE_DIR=${STATE_DIR:-/state}
ALERT_DIR=${ALERT_DIR:-/state/alerts}
CONTROL_DIR=${CONTROL_DIR:-/control}
PUBLIC_DIR=${PUBLIC_DIR:-/public}
DEFAULT_IMAGE=ghcr.io/cxsmtp/buh:latest
IMAGE=${IMAGE:-$DEFAULT_IMAGE}
ONE_SHOT=${ONE_SHOT:-0}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
SETTLE_SECONDS=${SETTLE_SECONDS:-10}
HEAL_CHECK_SECONDS=${HEAL_CHECK_SECONDS:-30}
UNHEALTHY_LIMIT=${UNHEALTHY_LIMIT:-3}
STOP_TIMEOUT=${STOP_TIMEOUT:-25}
LAST_GOOD=buh:last-good
PREVIOUS=buh:previous
IMAGE_SOURCE_LABEL=org.opencontainers.image.source=https://github.com/cxsmtp/buh
LOCK_STALE_SECONDS=900
PROJECT=
UPDATER_MODE=${UPDATER_MODE:-compose}
SHOP_NAME=${SHOP_NAME:-beautifuluaehome}
SHOP_PORT=${SHOP_PORT:-443}
SHOP_VOLUME=${SHOP_VOLUME:-beautifuluaehome-data}
SHOP_ENV=${SHOP_ENV-TZ=Asia/Dubai}
CONTROL_VOLUME=${CONTROL_VOLUME:-beautifuluaehome-updater-control}
STATUS_VOLUME=${STATUS_VOLUME:-beautifuluaehome-updater-status}
CANDIDATE=$SHOP_NAME-candidate
PREVIOUS_NAME=$SHOP_NAME-previous
SHOP_SPEC=
# What `adopt` carried over from the owner's container: its own settings (env file, given to
# `docker run --env-file`, values never logged) and its port bindings. Only root in the
# updater can read this folder (the updater's own volume).
CARRIED_DIR=$STATE_DIR/shop
SHOP_ENV_FILE=$CARRIED_DIR/env
SHOP_PORTS_FILE=$CARRIED_DIR/ports
SHOP_PORTS=$SHOP_PORT

# ── Small helpers ────────────────────────────────────────────────────────────

now() { date -u +%s; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  log_line="$(stamp) $*"
  printf '%s\n' "$log_line"
  printf '%s\n' "$log_line" >> "$STATE_DIR/updater.log" 2>/dev/null || true
}

is_number() {
  case $1 in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# setting KEY DEFAULT: the environment, else KEY=value in .env.production, else DEFAULT.
setting() {
  setting_value=$(printenv "$1" 2>/dev/null || true)
  if [ -z "$setting_value" ] && [ -r "$PROJECT_DIR/.env.production" ]; then
    setting_value=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$PROJECT_DIR/.env.production" | tail -n 1 |
      sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
  fi
  printf '%s' "${setting_value:-$2}"
}

json_escape() {
  printf '%s' "$1" | tr '\n\t' '  ' | tr -d '\000-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

short() {
  printf '%s' "$1" | sed 's/^sha256://' | cut -c1-12
}

image_id() {
  docker image inspect -f '{{.Id}}' "$1" 2>/dev/null
}

# Image ids compare without the "sha256:" prefix (an engine's API may leave it out).
same_image() {
  [ -n "$1" ] && [ "${1#sha256:}" = "${2#sha256:}" ]
}

# An id as a pattern for lines of bad-images, with or without the prefix (ids are hex).
id_pattern() {
  printf '(sha256:)?%s' "${1#sha256:}"
}

is_single() {
  [ "$UPDATER_MODE" = single ]
}

# "1.3.0 (3f2a…)" when the image carries a version label, else the short id.
describe() {
  describe_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true)
  case $describe_version in
    '' | '<no value>') short "$1" ;;
    *) printf '%s (%s)' "$describe_version" "$(short "$1")" ;;
  esac
}

other() {
  if [ "$1" = blue ]; then echo green; else echo blue; fi
}

# ── Alerts: the log, /data/updater/alerts.log (JSON lines, for the Admin Hub), a webhook ──

alert() {
  alert_level=$1
  shift
  alert_msg="$*"
  log "ALERT [$alert_level] $alert_msg"
  alert_json="{\"at\":\"$(stamp)\",\"level\":\"$alert_level\",\"message\":\"$(json_escape "$alert_msg")\"}"
  # The updater's own volume (never the shop's, which the shop's user controls).
  # Links are refused anyway, so nothing can redirect a write elsewhere.
  if mkdir -p "$ALERT_DIR" 2>/dev/null && [ ! -L "$ALERT_DIR" ]; then
    alert_file="$ALERT_DIR/alerts.log"
    if [ ! -L "$alert_file" ] && [ ! -L "$alert_file.tmp" ]; then
      if [ -f "$alert_file" ] && [ "$(wc -c < "$alert_file")" -gt 1048576 ]; then
        tail -n 1000 "$alert_file" > "$alert_file.tmp" && mv "$alert_file.tmp" "$alert_file"
      fi
      printf '%s\n' "$alert_json" >> "$alert_file"
      chmod 600 "$alert_file" 2>/dev/null || true
    fi
  fi
  send_webhook "$alert_level" "$alert_msg"
}

send_webhook() {
  hook_url=$(setting ALERT_WEBHOOK_URL '')
  [ -n "$hook_url" ] || return 0
  case $hook_url in
    https://*) ;;
    *)
      log "ALERT_WEBHOOK_URL must start with https://; alert not sent"
      return 0
      ;;
  esac
  # The same message at most once every 6 hours (a failing backup is retried every cycle).
  hook_key=$(printf '%s %s' "$1" "$2" | cksum | cut -d' ' -f1)
  hook_last="$STATE_DIR/last-webhook"
  if [ -f "$hook_last" ]; then
    read -r last_key last_at < "$hook_last" || true
    if [ "${last_key:-}" = "$hook_key" ] && is_number "${last_at:-}" && [ $(($(now) - last_at)) -lt 21600 ]; then
      return 0
    fi
  fi
  printf '%s %s\n' "$hook_key" "$(now)" > "$hook_last"
  hook_text="Beautiful UAE Home updater [$1]: $2"
  hook_body="{\"text\":\"$(json_escape "$hook_text")\",\"content\":\"$(json_escape "$hook_text")\",\"level\":\"$1\"}"
  if command -v curl > /dev/null 2>&1; then
    curl -fsS --proto '=https' --max-time 10 -H 'Content-Type: application/json' -d "$hook_body" "$hook_url" > /dev/null 2>&1 ||
      log "alert webhook did not answer"
  else
    wget -q -T 10 -O /dev/null --header 'Content-Type: application/json' --post-data "$hook_body" "$hook_url" > /dev/null 2>&1 ||
      log "alert webhook did not answer"
  fi
}

# ── A lock, so the loop and `update-now` never switch at the same time ─────────

lock() {
  if mkdir "$STATE_DIR/lock" 2> /dev/null; then
    printf '%s %s %s\n' "$(hostname)" "$$" "$(now)" > "$STATE_DIR/lock/owner"
    return 0
  fi
  lock_host='' lock_pid='' lock_at=''
  read -r lock_host lock_pid lock_at < "$STATE_DIR/lock/owner" 2> /dev/null || true
  lock_stale=0
  if [ "$lock_host" = "$(hostname)" ]; then
    kill -0 "$lock_pid" 2> /dev/null || lock_stale=1
  elif ! is_number "$lock_at" || [ $(($(now) - lock_at)) -gt "$LOCK_STALE_SECONDS" ]; then
    lock_stale=1
  fi
  if [ "$lock_stale" = 1 ]; then
    rm -rf "$STATE_DIR/lock"
    lock
    return $?
  fi
  return 1
}

unlock() {
  if [ -f "$STATE_DIR/lock/owner" ]; then
    read -r unlock_host unlock_pid _ < "$STATE_DIR/lock/owner" || true
    if [ "${unlock_host:-}" = "$(hostname)" ] && [ "${unlock_pid:-}" = "$$" ]; then
      rm -rf "$STATE_DIR/lock"
    fi
  fi
}

wait_for_lock() {
  wait_deadline=$(($(now) + 600))
  while ! lock; do
    if [ "$(now)" -ge "$wait_deadline" ]; then
      log "another update is still running; try again later"
      return 1
    fi
    log "waiting for the update that is already running"
    sleep 5
  done
}

# ── The two copies ───────────────────────────────────────────────────────────

# Container id of app-<colour>: running only, or any state with "all".
cid_of() {
  if [ "${2:-}" = all ]; then
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=app-$1" --filter "label=com.docker.compose.oneoff=False" | head -n 1
  else
    docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=app-$1" --filter "label=com.docker.compose.oneoff=False" | head -n 1
  fi
}

container_image() {
  docker inspect -f '{{.Image}}' "$1" 2> /dev/null
}

# healthy | unhealthy | starting | none, or "unhealthy" when it is not running.
health_of() {
  health_line=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2> /dev/null) ||
    {
      echo unhealthy
      return
    }
  # Podman's Docker API may give an empty status for an image without a healthcheck.
  case $health_line in
    'running ' | running) echo none ;;
    running\ *) echo "${health_line#running }" ;;
    *) echo unhealthy ;;
  esac
}

# probe_node CONTAINER PATH SECONDS: the app's answer, asked inside the container with its own
# node; fails on anything but 2xx. Single mode uses it: it needs nothing but the app's runtime.
probe_node() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:3000$2',{signal:AbortSignal.timeout(${3}000)}).then(async r=>{const t=await r.text();if(!r.ok)process.exit(1);process.stdout.write(t)}).catch(()=>process.exit(1))" 2> /dev/null
}

# The app answers /api/health with {"ok":true} (asked inside the container).
probe_health() {
  if is_single; then
    probe_node "$1" /api/health 5 | grep -q '"ok":true'
  else
    docker exec "$1" wget -q -T 5 -O - http://127.0.0.1:3000/api/health 2> /dev/null | grep -q '"ok":true'
  fi
}

# The storefront renders (busybox wget fails on anything but 2xx).
probe_page() {
  if is_single; then
    probe_node "$1" / 20 > /dev/null
  else
    docker exec "$1" wget -q -T 20 -O /dev/null http://127.0.0.1:3000/ 2> /dev/null
  fi
}

# Wait until the container's own healthcheck says healthy and the app answers.
# Gives up at once if it exits or crash-loops, else after HEALTH_TIMEOUT seconds.
wait_ready() {
  ready_cid=$1
  ready_deadline=$(($(now) + HEALTH_TIMEOUT))
  # wait_ready CONTAINER 0: a container just created, so any restart counts (it may already
  # have crashed and been restarted by its restart policy before the first look).
  ready_restarts=${2:-$(docker inspect -f '{{.RestartCount}}' "$ready_cid" 2> /dev/null || echo 0)}
  while [ "$(now)" -lt "$ready_deadline" ]; do
    # The health last: Podman's Docker API may leave it empty.
    ready_line=$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$ready_cid" 2> /dev/null) || {
      log "the container disappeared"
      return 1
    }
    read -r ready_status ready_count ready_health << EOF
$ready_line
EOF
    [ -n "$ready_health" ] || ready_health=none
    # Single mode asks the app itself (below), whatever the engine's healthcheck says.
    if is_single; then ready_health=none; fi
    case $ready_status in
      exited | dead)
        log "it exited: $(docker logs --tail 5 "$ready_cid" 2>&1 | tr '\n' ' ')"
        return 1
        ;;
    esac
    if [ "$ready_count" != "$ready_restarts" ]; then
      log "it crashed and was restarted: $(docker logs --tail 5 "$ready_cid" 2>&1 | tr '\n' ' ')"
      return 1
    fi
    if [ "$ready_health" = unhealthy ]; then
      log "its healthcheck says unhealthy"
      return 1
    fi
    if [ "$ready_status" = running ] && { [ "$ready_health" = healthy ] || [ "$ready_health" = none ]; } && probe_health "$ready_cid"; then
      return 0
    fi
    sleep 2
  done
  log "not healthy after ${HEALTH_TIMEOUT}s"
  return 1
}

# start_colour COLOUR IMAGE: create or start app-COLOUR from IMAGE (a tag or id).
start_colour() {
  log "starting app-$1 from $2"
  start_rc=0
  start_out=$(BUH_IMAGE=$2 docker compose -p "$PROJECT" up -d --no-deps --pull never "app-$1" 2>&1) || start_rc=$?
  printf '%s\n' "$start_out" | while IFS= read -r start_line; do
    [ -z "$start_line" ] || log "  compose: $start_line"
  done
  [ "$start_rc" = 0 ] && [ -n "$(cid_of "$1")" ]
}

stop_colour() {
  stop_cid=$(cid_of "$1" all)
  [ -n "$stop_cid" ] || return 0
  log "stopping app-$1 (up to ${2:-$STOP_TIMEOUT}s for requests in flight)"
  docker stop -t "${2:-$STOP_TIMEOUT}" "$stop_cid" > /dev/null 2>&1 || true
}

remove_colour() {
  remove_cid=$(cid_of "$1" all)
  [ -n "$remove_cid" ] || return 0
  docker stop -t 10 "$remove_cid" > /dev/null 2>&1 || true
  docker rm "$remove_cid" > /dev/null 2>&1 || true
}

# The colour serving now (empty when none runs).
running_colour() {
  if [ -n "$(cid_of blue)" ]; then echo blue; elif [ -n "$(cid_of green)" ]; then echo green; fi
}

recorded_active() {
  recorded=$(cat "$STATE_DIR/active" 2> /dev/null || true)
  case $recorded in blue | green) echo "$recorded" ;; *) echo blue ;; esac
}

remember_good() {
  docker tag "${1#sha256:}" "$LAST_GOOD" > /dev/null
  printf '%s\n' "$1" > "$STATE_DIR/last-good"
  # A manual switch to an image clears an earlier rejection of it.
  forget_bad "$1"
}

forget_bad() {
  if [ -f "$STATE_DIR/bad-images" ]; then
    grep -vxE "$(id_pattern "$1")" "$STATE_DIR/bad-images" > "$STATE_DIR/bad-images.tmp" || true
    mv "$STATE_DIR/bad-images.tmp" "$STATE_DIR/bad-images"
  fi
}

remember_bad() {
  is_bad "$1" || printf '%s\n' "$1" >> "$STATE_DIR/bad-images"
}

is_bad() {
  grep -qxE "$(id_pattern "$1")" "$STATE_DIR/bad-images" 2> /dev/null
}

last_good_ref() {
  if image_id "$LAST_GOOD" > /dev/null; then echo "$LAST_GOOD"; else echo "$IMAGE"; fi
}

# ── Backup before switching ──────────────────────────────────────────────────

backup_in() {
  if docker exec "$1" test -f scripts/backup-now.mjs; then
    docker exec "$1" node scripts/backup-now.mjs 2>&1
  elif is_single; then
    # No checkout to borrow the script from: switching away from such a version is refused.
    echo "this version has no database snapshot tool (it is older than BUH-02.00.00), so the updater does not switch away from it; update it once by hand (deployment guide, Podman on Windows)"
    return 1
  else
    # A version from before backup-now.mjs: run this checkout's copy inside it.
    docker exec -i "$1" node --input-type=module - < "$PROJECT_DIR/scripts/backup-now.mjs" 2>&1
  fi
}

# ── Switch: the zero-downtime move to another image ─────────────────────────────

# switch_to IMAGE WHY: 0 switched, 1 the new copy failed (old one still serving), 2 error.
switch_to() {
  sw_ref=$1
  sw_why=$2
  sw_new=$(image_id "$sw_ref") || {
    alert error "$sw_why: image $sw_ref is not on this server"
    return 2
  }
  sw_active=$(running_colour)
  if [ -z "$sw_active" ]; then
    log "no copy is running; the self-healing check starts one first"
    return 2
  fi
  sw_active_cid=$(cid_of "$sw_active")
  sw_old=$(container_image "$sw_active_cid")
  sw_idle=$(other "$sw_active")
  log "$sw_why: app-$sw_active runs $(describe "$sw_old"); switching to $(describe "$sw_new") on app-$sw_idle"

  log "step 1/4: snapshot of the database, taken by app-$sw_active"
  if ! sw_out=$(backup_in "$sw_active_cid"); then
    alert error "$sw_why: the database snapshot failed, so $(describe "$sw_new") was not started; the shop runs $(describe "$sw_old") as before. $sw_out"
    return 2
  fi
  log "  $sw_out"

  log "step 2/4: start app-$sw_idle"
  remove_colour "$sw_idle"
  sw_problem=''
  if ! start_colour "$sw_idle" "$sw_ref"; then
    sw_problem='it could not be started'
  else
    sw_cid=$(cid_of "$sw_idle")
    if ! same_image "$(container_image "$sw_cid")" "$sw_new"; then
      sw_problem="it started $(short "$(container_image "$sw_cid")") instead of the expected image"
    else
      log "step 3/4: wait until app-$sw_idle is healthy (up to ${HEALTH_TIMEOUT}s), then load its home page"
      if ! wait_ready "$sw_cid"; then
        sw_problem='it did not become healthy'
      elif ! probe_page "$sw_cid"; then
        sw_problem='its home page did not load'
      fi
    fi
  fi

  if [ -n "$sw_problem" ]; then
    log "app-$sw_idle: $sw_problem; removing it"
    remove_colour "$sw_idle"
    remember_bad "$sw_new"
    alert error "$sw_why: $(describe "$sw_new") failed ($sw_problem). Rolled back: app-$sw_active keeps serving $(describe "$sw_old"). This image is not tried again; a newer one will be."
    return 1
  fi

  log "step 4/4: app-$sw_idle is healthy; giving Caddy ${SETTLE_SECONDS}s to see it, then stopping app-$sw_active"
  remember_good "$sw_new"
  if [ "$sw_old" != "$sw_new" ]; then docker tag "$sw_old" "$PREVIOUS" > /dev/null; fi
  printf '%s\n' "$sw_idle" > "$STATE_DIR/active"
  sleep "$SETTLE_SECONDS"
  stop_colour "$sw_active"
  docker image prune -f --filter "label=$IMAGE_SOURCE_LABEL" > /dev/null 2>&1 || true
  alert info "$sw_why: the shop now runs $(describe "$sw_new") on app-$sw_idle (was $(describe "$sw_old"), kept as $PREVIOUS)."
  return 0
}

# ── Which container serves, in either mode ───────────────────────────────────

# The container serving now (empty when none runs).
serving_cid() {
  if is_single; then
    if [ "$(state_of "$SHOP_NAME")" = running ]; then printf '%s\n' "$SHOP_NAME"; fi
  else
    sc_colour=$(running_colour)
    if [ -n "$sc_colour" ]; then cid_of "$sc_colour"; fi
  fi
}

serving_name() {
  if is_single; then printf '%s' "$SHOP_NAME"; else printf 'app-%s' "$(running_colour)"; fi
}

# switch_image IMAGE WHY: 0 switched, 1 the new version failed (the old one serves), 2 error.
switch_image() {
  if is_single; then single_switch "$@"; else switch_to "$@"; fi
}

# ── Single-container mode (UPDATER_MODE=single) ──────────────────────────────

# running | exited | created | …; nothing (and status 1) when there is no such container.
state_of() {
  docker inspect -f '{{.State.Status}}' "$1" 2> /dev/null
}

# The volume a container keeps /data in (empty for a host folder, or none).
data_volume_of() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$1" 2> /dev/null
}

spec_of() {
  docker inspect -f '{{index .Config.Labels "buh.updater.spec"}}' "$1" 2> /dev/null
}

# A container or volume name: letters, digits, _ . - (not first), at most 64.
valid_name() {
  case $1 in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9_.-]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

bad_setting() {
  echo "updater: $*" >&2
  cs_ok=1
}

# Every value that goes into `docker run` is checked before anything runs: only plain
# names, a port number and KEY=VALUE pairs of safe characters, so nothing can add a flag,
# a mount or a shell command. (The values are passed as separate arguments anyway.)
check_single_settings() {
  cs_ok=0
  valid_name "$SHOP_NAME" || bad_setting "SHOP_NAME must be letters, digits, _ . - (starting with a letter or digit, at most 64)"
  valid_name "$SHOP_VOLUME" || bad_setting "SHOP_VOLUME must be letters, digits, _ . - (starting with a letter or digit, at most 64)"
  valid_name "$CONTROL_VOLUME" || bad_setting "CONTROL_VOLUME must be letters, digits, _ . - (starting with a letter or digit, at most 64)"
  valid_name "$STATUS_VOLUME" || bad_setting "STATUS_VOLUME must be letters, digits, _ . - (starting with a letter or digit, at most 64)"
  if [ "$SHOP_VOLUME" = "$CONTROL_VOLUME" ] || [ "$SHOP_VOLUME" = "$STATUS_VOLUME" ] || [ "$CONTROL_VOLUME" = "$STATUS_VOLUME" ]; then
    bad_setting "SHOP_VOLUME, CONTROL_VOLUME and STATUS_VOLUME must be three different volumes"
  fi
  case $SHOP_PORT in
    '' | *[!0-9]* | 0*) bad_setting "SHOP_PORT must be a port number, 1 to 65535" ;;
    *) if [ "${#SHOP_PORT}" -gt 5 ] || [ "$SHOP_PORT" -gt 65535 ]; then bad_setting "SHOP_PORT must be a port number, 1 to 65535"; fi ;;
  esac
  case $IMAGE in
    '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._/:@-]*) bad_setting "IMAGE must be an image name such as ghcr.io/cxsmtp/buh:latest" ;;
  esac
  cs_count=0
  set -f
  for cs_pair in $SHOP_ENV; do
    cs_count=$((cs_count + 1))
    case $cs_pair in
      *=*) ;;
      *)
        bad_setting "SHOP_ENV: each entry is KEY=VALUE, separated by spaces"
        continue
        ;;
    esac
    cs_key=${cs_pair%%=*}
    cs_value=${cs_pair#*=}
    case $cs_key in
      '' | [!A-Z_]* | *[!A-Z0-9_]*)
        bad_setting "SHOP_ENV: a key must be capital letters, digits and _, starting with a letter or _"
        continue
        ;;
      DATA_DIR | PORT | HOSTNAME | NODE_ENV | UPDATER_STATUS_DIR | UPDATER_CONTROL_DIR)
        bad_setting "SHOP_ENV: $cs_key is set by the updater and cannot be changed"
        continue
        ;;
    esac
    case $cs_value in
      *[!A-Za-z0-9_.,:/@+=-]*) bad_setting "SHOP_ENV: the value of $cs_key may hold only letters, digits and _ . , : / @ + = - (no spaces or quotes)" ;;
    esac
    [ "${#cs_value}" -le 256 ] || bad_setting "SHOP_ENV: the value of $cs_key is longer than 256 characters"
  done
  set +f
  [ "$cs_count" -le 32 ] || bad_setting "SHOP_ENV: at most 32 entries"
  [ "$cs_ok" = 0 ] || return 1
  load_carried
}

# A host port binding: PORT or IPv4:PORT.
valid_binding() {
  vb_port=${1##*:}
  case $vb_port in '' | *[!0-9]* | 0*) return 1 ;; esac
  [ "${#vb_port}" -le 5 ] && [ "$vb_port" -le 65535 ] || return 1
  case $1 in
    *:*) printf '%s' "${1%:*}" | grep -Eqx '[0-9]{1,3}(\.[0-9]{1,3}){3}' ;;
    *) return 0 ;;
  esac
}

# spec_for PORTS ENV_FILE: changes whenever the definition changes, so a container started
# any other way (or with other settings) is noticed. The env file counts by its checksum.
spec_for() {
  sf_env=none
  if [ -n "$2" ] && [ -f "$2" ]; then sf_env=$(cksum < "$2" | cut -d' ' -f1); fi
  printf 'v2 %s %s %s %s %s %s' "$1" "$SHOP_VOLUME" "$CONTROL_VOLUME" "$STATUS_VOLUME" \
    "$(printf '%s' "$SHOP_ENV" | tr -s '[:space:]' ' ')" "$sf_env" | cksum | cut -d' ' -f1
}

# The port bindings and env file carried over by `adopt`, if any, and the resulting spec.
load_carried() {
  SHOP_PORTS=$SHOP_PORT
  if [ -f "$SHOP_PORTS_FILE" ] && [ ! -L "$SHOP_PORTS_FILE" ]; then
    lc_ports=''
    while IFS= read -r lc_line; do
      if ! valid_binding "$lc_line"; then
        log "ignoring $SHOP_PORTS_FILE: it does not hold port bindings"
        lc_ports=''
        break
      fi
      lc_ports="${lc_ports:+$lc_ports }$lc_line"
    done < "$SHOP_PORTS_FILE"
    [ -z "$lc_ports" ] || SHOP_PORTS=$lc_ports
  fi
  lc_env=''
  if [ -f "$SHOP_ENV_FILE" ] && [ ! -L "$SHOP_ENV_FILE" ]; then lc_env=$SHOP_ENV_FILE; fi
  SHOP_SPEC=$(spec_for "$SHOP_PORTS" "$lc_env")
}

# run_shop CONTAINER IMAGE port|noport: start the shop from the one fixed definition.
# "noport" is the trial copy: the same data and settings, no host port, no restart.
run_shop() {
  rs_name=$1
  rs_ref=$2
  rs_image=${2#sha256:}
  rs_port=$3
  set -f
  set -- run -d --name "$rs_name" --label "buh.updater.spec=$SHOP_SPEC"
  if [ "$rs_port" = port ]; then
    set -- "$@" --restart unless-stopped
    for rs_bind in $SHOP_PORTS; do
      set -- "$@" -p "$rs_bind:3000"
    done
  fi
  set -- "$@" -v "$SHOP_VOLUME:/data" -v "$CONTROL_VOLUME:/updater-control" -v "$STATUS_VOLUME:/updater-status:ro"
  # The owner's own settings (secrets among them): read by the docker CLI here, never logged.
  if [ -f "$SHOP_ENV_FILE" ] && [ ! -L "$SHOP_ENV_FILE" ]; then
    set -- "$@" --env-file "$SHOP_ENV_FILE"
  fi
  for rs_pair in $SHOP_ENV; do
    set -- "$@" -e "$rs_pair"
  done
  set +f
  # --pids-limit as in docker-compose.yml; also, Podman's Docker API reads "no limit" from the
  # docker CLI as a limit of 0 on some hosts, and the shop could not start a process.
  set -- "$@" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 "$rs_image"
  if [ "$rs_port" = port ]; then
    log "starting $rs_name from $rs_ref on port $SHOP_PORTS"
  else
    log "starting $rs_name from $rs_ref (no port)"
  fi
  rs_out=$(docker "$@" 2>&1) && return 0
  log "  it did not start: $(printf '%s' "$rs_out" | tail -n 3 | tr '\n' ' ')"
  return 1
}

# The last lines of a container's log, on one line.
log_tail() {
  docker logs --tail 5 "$1" 2>&1 | tr '\n' ' '
}

# Refuse to touch a container whose data is not in SHOP_VOLUME: re-creating it on
# SHOP_VOLUME would start the shop on other (or no) data.
single_guard() {
  sg_vol=$(data_volume_of "$1")
  if [ "$sg_vol" != "$SHOP_VOLUME" ]; then
    alert critical "$1 keeps its data in ${sg_vol:-a host folder (or nowhere)}, not in the volume $SHOP_VOLUME, so the updater leaves it alone. Set SHOP_VOLUME to the volume it uses (scripts/podman-autoupdate.bat does)."
    return 1
  fi
  volume_free
}

# Running containers other than ours (SHOP_NAME, -candidate, -previous) on SHOP_VOLUME.
others_on_volume() {
  for ov_id in $(docker ps -q 2> /dev/null); do
    ov_line=$(docker inspect -f '{{.Name}}|{{range .Mounts}}{{.Name}};{{end}}' "$ov_id" 2> /dev/null) || continue
    ov_name=${ov_line%%|*}
    ov_name=${ov_name#/}
    case $ov_name in "$SHOP_NAME" | "$CANDIDATE" | "$PREVIOUS_NAME") continue ;; esac
    case ";${ov_line#*|}" in *";$SHOP_VOLUME;"*) printf '%s ' "$ov_name" ;; esac
  done
}

# Two shops on one database (and one port) must never run: nothing is started while
# another running container uses SHOP_VOLUME.
volume_free() {
  vf_others=$(others_on_volume)
  [ -z "$vf_others" ] && return 0
  alert critical "another running container uses the data volume $SHOP_VOLUME: ${vf_others% }. Two shops must never share it, so the updater starts nothing. Stop that container, or if it is the shop, set the updater up with its name (scripts\\podman-autoupdate.bat ${vf_others%% *} …)."
  return 1
}

# Stop SHOP_NAME, keep it as PREVIOUS_NAME, start IMAGE as SHOP_NAME with the port.
# single_takeover IMAGE NEW_ID: 0 serves (tk_paused: seconds closed), 1 failed (the previous
# container is put back; tk_restored=1 when it answers again), 2 nothing changed.
single_takeover() {
  tk_ref=$1
  tk_new=$2
  tk_problem=''
  tk_restored=0
  tk_paused=0
  docker rm -f "$PREVIOUS_NAME" > /dev/null 2>&1 || true
  tk_started=$(now)
  if [ "$(state_of "$SHOP_NAME")" = running ]; then
    log "stopping $SHOP_NAME (up to ${STOP_TIMEOUT}s for requests in flight); the shop is closed until the new one answers"
    docker stop -t "$STOP_TIMEOUT" "$SHOP_NAME" > /dev/null 2>&1 || true
  fi
  if ! docker rename "$SHOP_NAME" "$PREVIOUS_NAME" > /dev/null 2>&1; then
    docker start "$SHOP_NAME" > /dev/null 2>&1 || true
    tk_problem="$SHOP_NAME could not be set aside as $PREVIOUS_NAME"
    return 2
  fi
  if ! run_shop "$SHOP_NAME" "$tk_ref" port; then
    tk_problem="it could not be started on port $SHOP_PORTS"
  elif ! same_image "$(container_image "$SHOP_NAME")" "$tk_new"; then
    tk_problem="it started $(short "$(container_image "$SHOP_NAME")") instead of the expected image"
  elif ! wait_ready "$SHOP_NAME" 0; then
    tk_problem="it did not become healthy on port $SHOP_PORTS"
  elif ! probe_page "$SHOP_NAME"; then
    tk_problem='its home page did not load'
  fi
  if [ -z "$tk_problem" ]; then
    tk_paused=$(($(now) - tk_started))
    log "the shop answers again after ${tk_paused}s"
    return 0
  fi
  log "$SHOP_NAME: $tk_problem; removing it and putting $PREVIOUS_NAME back. Its log: $(log_tail "$SHOP_NAME")"
  docker rm -f "$SHOP_NAME" > /dev/null 2>&1 || true
  if docker rename "$PREVIOUS_NAME" "$SHOP_NAME" > /dev/null 2>&1 &&
    docker start "$SHOP_NAME" > /dev/null 2>&1 && wait_ready "$SHOP_NAME"; then
    tk_restored=1
  fi
  return 1
}

# single_switch IMAGE WHY: 0 switched, 1 the new version failed (the old one serves), 2 error.
single_switch() {
  ss_ref=$1
  ss_why=$2
  ss_new=$(image_id "$ss_ref") || {
    alert error "$ss_why: image $ss_ref is not on this server"
    return 2
  }
  if [ "$(state_of "$SHOP_NAME")" != running ]; then
    log "$SHOP_NAME is not running; the self-healing check starts it first"
    return 2
  fi
  single_guard "$SHOP_NAME" || return 2
  ss_old=$(container_image "$SHOP_NAME")
  log "$ss_why: $SHOP_NAME runs $(describe "$ss_old"); switching to $(describe "$ss_new") (the shop pauses for a few seconds at the switch)"

  log "step 1/4: snapshot of the database, taken by $SHOP_NAME"
  if ! ss_out=$(backup_in "$SHOP_NAME"); then
    alert error "$ss_why: the database snapshot failed, so $(describe "$ss_new") was not started; the shop runs $(describe "$ss_old") as before. $ss_out"
    return 2
  fi
  log "  $ss_out"
  # Stopping (a new set-up, a restart): no switch is started; one under way is finished.
  if [ "$stop_requested" = 1 ]; then
    log "the updater is stopping, so the switch is not started"
    return 2
  fi

  log "step 2/4: try it as $CANDIDATE (same data, no port) while $SHOP_NAME keeps serving; up to ${HEALTH_TIMEOUT}s"
  docker rm -f "$CANDIDATE" > /dev/null 2>&1 || true
  ss_problem=''
  if ! run_shop "$CANDIDATE" "$ss_ref" noport; then
    ss_problem='it could not be started'
  elif ! same_image "$(container_image "$CANDIDATE")" "$ss_new"; then
    ss_problem="it started $(short "$(container_image "$CANDIDATE")") instead of the expected image"
  elif ! wait_ready "$CANDIDATE" 0; then
    ss_problem='it did not become healthy'
  elif ! probe_page "$CANDIDATE"; then
    ss_problem='its home page did not load'
  fi
  docker stop -t 10 "$CANDIDATE" > /dev/null 2>&1 || true
  docker rm -f "$CANDIDATE" > /dev/null 2>&1 || true
  if [ -n "$ss_problem" ]; then
    # Re-creating the running image (adopt) never marks it bad.
    same_image "$ss_new" "$ss_old" || remember_bad "$ss_new"
    alert error "$ss_why: $(describe "$ss_new") failed ($ss_problem). Rolled back: $SHOP_NAME never stopped and keeps serving $(describe "$ss_old"). This image is not tried again; a newer one will be."
    return 1
  fi

  if [ "$stop_requested" = 1 ]; then
    log "the updater is stopping, so the switch ends here; $SHOP_NAME keeps serving $(describe "$ss_old")"
    return 2
  fi
  log "step 3/4: it works; stopping $SHOP_NAME (kept as $PREVIOUS_NAME) and starting the new version on port $SHOP_PORTS"
  ss_rc=0
  single_takeover "$ss_ref" "$ss_new" || ss_rc=$?
  if [ "$ss_rc" = 2 ]; then
    alert error "$ss_why: $tk_problem; nothing changed, the shop runs $(describe "$ss_old")"
    return 2
  fi
  if [ "$ss_rc" != 0 ]; then
    same_image "$ss_new" "$ss_old" || remember_bad "$ss_new"
    if [ "$tk_restored" = 1 ]; then
      alert error "$ss_why: $(describe "$ss_new") passed its trial but failed as $SHOP_NAME ($tk_problem). Rolled back: the previous container is back on port $SHOP_PORTS and serves $(describe "$ss_old"). This image is not tried again; a newer one will be."
    else
      alert critical "$ss_why: $(describe "$ss_new") failed as $SHOP_NAME ($tk_problem), and the previous container did not answer again either; the self-healing check now starts $(last_good_ref). See: podman logs $SHOP_NAME"
    fi
    return 1
  fi

  log "step 4/4: $SHOP_NAME serves $(describe "$ss_new")"
  remember_good "$ss_new"
  if ! same_image "$ss_old" "$ss_new"; then docker tag "${ss_old#sha256:}" "$PREVIOUS" > /dev/null; fi
  docker image prune -f --filter "label=$IMAGE_SOURCE_LABEL" > /dev/null 2>&1 || true
  if same_image "$ss_old" "$ss_new"; then
    alert info "$ss_why: $SHOP_NAME runs $(describe "$ss_new") again, re-created with the updater's settings (the old container is kept, stopped, as $PREVIOUS_NAME); it was closed for ${tk_paused}s."
  else
    alert info "$ss_why: the shop now runs $(describe "$ss_new") (was $(describe "$ss_old"), kept as $PREVIOUS and as the stopped container $PREVIOUS_NAME); it was closed for ${tk_paused}s while switching."
  fi
  return 0
}

# Start SHOP_NAME afresh from the last good image (the old container is removed; its data
# is in the volume). Never on a missing data volume: that would be a shop with no data.
single_recreate() {
  sr_ref=$(last_good_ref)
  if ! docker volume inspect "$SHOP_VOLUME" > /dev/null 2>&1; then
    alert critical "the data volume $SHOP_VOLUME does not exist, so no shop is started on empty data. Check the name (podman volume ls) and SHOP_VOLUME."
    return 1
  fi
  volume_free || return 1
  docker rm -f "$SHOP_NAME" > /dev/null 2>&1 || true
  if run_shop "$SHOP_NAME" "$sr_ref" port && wait_ready "$SHOP_NAME" 0 && probe_page "$SHOP_NAME"; then
    return 0
  fi
  log "  $SHOP_NAME did not come up: $(log_tail "$SHOP_NAME")"
  return 1
}

single_heal() {
  if state_of "$CANDIDATE" > /dev/null; then
    log "removing $CANDIDATE, left over from an interrupted switch"
    docker rm -f "$CANDIDATE" > /dev/null 2>&1 || true
  fi
  sh_state=$(state_of "$SHOP_NAME") || sh_state=''
  if [ -n "$sh_state" ] && ! single_guard "$SHOP_NAME"; then return 1; fi

  if [ "$sh_state" = running ]; then
    if probe_health "$SHOP_NAME"; then
      printf '0\n' > "$STATE_DIR/unhealthy-count"
      # First run: the container that serves well is the last good one.
      if ! image_id "$LAST_GOOD" > /dev/null; then
        sh_img=$(container_image "$SHOP_NAME")
        remember_good "$sh_img"
        log "recorded $(describe "$sh_img") as $LAST_GOOD"
      fi
      # Started some other way (by hand: no request/status volumes): set it up again.
      if [ "$(spec_of "$SHOP_NAME")" != "$SHOP_SPEC" ]; then reapply_spec; fi
      return 0
    fi
    sh_count=$(cat "$STATE_DIR/unhealthy-count" 2> /dev/null || echo 0)
    is_number "$sh_count" || sh_count=0
    sh_count=$((sh_count + 1))
    printf '%s\n' "$sh_count" > "$STATE_DIR/unhealthy-count"
    log "$SHOP_NAME does not answer ($sh_count of $UNHEALTHY_LIMIT checks)"
    [ "$sh_count" -ge "$UNHEALTHY_LIMIT" ] || return 0
    printf '0\n' > "$STATE_DIR/unhealthy-count"
    alert warning "$SHOP_NAME did not answer for $sh_count checks in a row; restarting it"
    docker restart -t "$STOP_TIMEOUT" "$SHOP_NAME" > /dev/null 2>&1 || true
    if wait_ready "$SHOP_NAME"; then
      alert info "$SHOP_NAME answers again after a restart"
      return 0
    fi
    alert error "$SHOP_NAME still does not answer after a restart; starting it afresh from $(last_good_ref)"
  elif [ -z "$sh_state" ]; then
    alert error "the shop container $SHOP_NAME does not exist; starting it from $(last_good_ref)"
  else
    alert error "the shop container $SHOP_NAME was not running ($sh_state); starting it"
    if docker start "$SHOP_NAME" > /dev/null 2>&1 && wait_ready "$SHOP_NAME" && probe_page "$SHOP_NAME"; then
      alert info "recovered: $SHOP_NAME serves again"
      return 0
    fi
    log "  it did not start: $(log_tail "$SHOP_NAME")"
  fi
  if single_recreate; then
    alert info "recovered: $SHOP_NAME serves $(describe "$(container_image "$SHOP_NAME")") again"
    return 0
  fi
  alert critical "the shop is down: $SHOP_NAME does not start from $(last_good_ref). See: podman logs $SHOP_NAME"
  return 1
}

drop_last_empty() {
  awk 'NR > 1 { print prev } { prev = $0 } END { if (NR > 0 && prev != "") print prev }'
}

# carry_settings CONTAINER: what the owner's container has beyond the image, into a new
# root-only folder (printed): env (its own settings, minus the image's), ports (host port
# bindings of 3000). Anything that cannot be carried is listed (keys only, never values);
# then status 1 and nothing is kept.
carry_settings() {
  cr_c=$1
  cr_dir=$(umask 077 && mktemp -d "$STATE_DIR/.carry.XXXXXX") || return 1
  cr_problems=''
  cr_img=$(container_image "$cr_c")
  # One entry a line (the CLI adds one more line break at the end: dropped). A value with a
  # line break shows as more lines than entries, or as an empty line.
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cr_c" 2> /dev/null | drop_last_empty > "$cr_dir/all"
  docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${cr_img#sha256:}" 2> /dev/null | drop_last_empty > "$cr_dir/image"
  cr_count=$(docker inspect -f '{{len .Config.Env}}' "$cr_c" 2> /dev/null || echo 0)
  if [ "$(grep -c '' < "$cr_dir/all")" != "$cr_count" ] || grep -q '^$' "$cr_dir/all"; then
    cr_problems="$cr_problems
  - a setting whose value has a line break (set it again on one line)"
  fi
  (umask 077 && : > "$cr_dir/env")
  while IFS= read -r cr_line; do
    grep -Fxq -e "$cr_line" "$cr_dir/image" && continue
    cr_key=${cr_line%%=*}
    case $cr_key in
      HOSTNAME | HOME | TERM | container) continue ;; # set by the engine, not by the owner
      '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
        cr_problems="$cr_problems
  - a setting with a name that is not letters, digits and _"
        continue
        ;;
      DATA_DIR | PORT | NODE_ENV | UPDATER_STATUS_DIR | UPDATER_CONTROL_DIR)
        cr_problems="$cr_problems
  - the setting $cr_key (the updater fixes it)"
        continue
        ;;
    esac
    case $cr_line in *=*) ;; *) continue ;; esac
    # SHOP_ENV gives its own value for this key.
    case " $(printf '%s' "$SHOP_ENV" | tr -s '[:space:]' ' ') " in *" $cr_key="*) continue ;; esac
    printf '%s\n' "$cr_line" >> "$cr_dir/env"
  done < "$cr_dir/all"
  # In a fixed order, so the same settings always give the same file (engines list env differently).
  sort -o "$cr_dir/env" "$cr_dir/env"

  docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}}|{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' "$cr_c" > "$cr_dir/bindings" 2> /dev/null
  : > "$cr_dir/ports"
  while IFS='|' read -r cr_cport cr_ip cr_hport; do
    [ -n "$cr_cport" ] || continue
    if [ "$cr_cport" != 3000/tcp ]; then
      cr_problems="$cr_problems
  - the port ${cr_hport:-?} -> $cr_cport (only the shop's port 3000/tcp is carried)"
      continue
    fi
    case $cr_ip in '' | 0.0.0.0 | ::) cr_bind=$cr_hport ;; *) cr_bind=$cr_ip:$cr_hport ;; esac
    if ! valid_binding "$cr_bind"; then
      cr_problems="$cr_problems
  - the port binding ${cr_ip:+$cr_ip }${cr_hport:-(random)} -> 3000"
      continue
    fi
    grep -Fxq -e "$cr_bind" "$cr_dir/ports" || printf '%s\n' "$cr_bind" >> "$cr_dir/ports"
  done < "$cr_dir/bindings"

  docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}{{println}}{{end}}' "$cr_c" > "$cr_dir/mounts" 2> /dev/null
  while IFS='|' read -r cr_type cr_name cr_src cr_dest; do
    [ -n "$cr_dest" ] || continue
    case "$cr_dest|$cr_name" in
      "/data|$SHOP_VOLUME" | "/updater-control|$CONTROL_VOLUME" | "/updater-status|$STATUS_VOLUME") continue ;;
    esac
    cr_problems="$cr_problems
  - the ${cr_type:-mount} ${cr_name:-$cr_src} at $cr_dest"
  done < "$cr_dir/mounts"

  if [ -n "$cr_problems" ]; then
    rm -rf "$cr_dir"
    log "refusing: $cr_c has settings the updater cannot carry over to the container it starts, so nothing was changed:$cr_problems
Start the shop without them (or move that data into $SHOP_VOLUME), then run the set-up again." >&2
    return 1
  fi
  printf '%s' "$cr_dir"
}

# Put carried settings in place (the ones before are kept as .bak until the switch is done).
install_carried() {
  mkdir -p "$CARRIED_DIR" && chmod 700 "$CARRIED_DIR"
  for ic_f in env ports; do
    rm -f "$CARRIED_DIR/$ic_f.bak"
    if [ -f "$CARRIED_DIR/$ic_f" ]; then mv "$CARRIED_DIR/$ic_f" "$CARRIED_DIR/$ic_f.bak"; fi
    if [ -s "$1/$ic_f" ]; then mv "$1/$ic_f" "$CARRIED_DIR/$ic_f" && chmod 600 "$CARRIED_DIR/$ic_f"; fi
  done
  rm -rf "$1"
  load_carried
}

restore_carried() {
  for rc_f in env ports; do
    rm -f "$CARRIED_DIR/$rc_f"
    if [ -f "$CARRIED_DIR/$rc_f.bak" ]; then mv "$CARRIED_DIR/$rc_f.bak" "$CARRIED_DIR/$rc_f"; fi
  done
  load_carried
}

# Set-up (scripts/podman-autoupdate.bat runs it once): make SHOP_NAME the container this
# script defines, with the request and status volumes, keeping its image, data volume, port
# bindings and its own settings. 0 done (or nothing to do), 1 the new container failed (the
# old one is back), 2 refused.
adopt() {
  ad_state=$(state_of "$SHOP_NAME") || ad_state=''
  if [ -z "$ad_state" ]; then
    volume_free || return 2
    if docker volume inspect "$SHOP_VOLUME" > /dev/null 2>&1; then
      log "no container $SHOP_NAME yet; starting one on the existing data volume $SHOP_VOLUME"
    else
      log "no container $SHOP_NAME and no volume $SHOP_VOLUME: a new shop, with a new data volume"
    fi
    docker pull -q "$IMAGE" > /dev/null 2>&1 || log "could not pull $IMAGE; using the copy on this server, if any"
    if ! image_id "$IMAGE" > /dev/null; then
      log "no image $IMAGE on this server"
      return 2
    fi
    if run_shop "$SHOP_NAME" "$IMAGE" port && wait_ready "$SHOP_NAME" 0 && probe_page "$SHOP_NAME"; then
      remember_good "$(image_id "$IMAGE")"
      log "$SHOP_NAME serves on port $SHOP_PORTS"
      return 0
    fi
    log "$SHOP_NAME did not come up: $(log_tail "$SHOP_NAME")"
    return 1
  fi

  ad_vol=$(data_volume_of "$SHOP_NAME")
  if [ "$ad_vol" != "$SHOP_VOLUME" ]; then
    if [ -n "$ad_vol" ]; then
      log "refusing: $SHOP_NAME keeps its data in the volume $ad_vol, not $SHOP_VOLUME. Run the set-up again with that volume: scripts\\podman-autoupdate.bat $SHOP_NAME $SHOP_PORT $ad_vol"
    else
      log "refusing: $SHOP_NAME keeps its data in a host folder (or nowhere), not in the volume $SHOP_VOLUME; move it into a volume first"
    fi
    return 2
  fi
  volume_free || return 2
  ad_dir=$(carry_settings "$SHOP_NAME") || return 2
  ad_ports=$(tr '\n' ' ' < "$ad_dir/ports" | sed 's/ *$//')
  [ -n "$ad_ports" ] || ad_ports=$SHOP_PORT
  ad_env=''
  if [ -s "$ad_dir/env" ]; then ad_env=$ad_dir/env; fi
  if [ "$ad_state" = running ] && [ "$(spec_of "$SHOP_NAME")" = "$(spec_for "$ad_ports" "$ad_env")" ]; then
    install_carried "$ad_dir"
    log "$SHOP_NAME already runs with these settings; nothing to change"
    return 0
  fi
  ad_keys=$(cut -d= -f1 < "$ad_dir/env" | tr '\n' ' ' | sed 's/ *$//')
  install_carried "$ad_dir"
  log "carrying over from $SHOP_NAME: port $SHOP_PORTS; its own settings: ${ad_keys:-none} (values kept in the updater's volume, not logged)"
  if [ "$ad_state" != running ]; then
    log "$SHOP_NAME is $ad_state; starting it first, for the database snapshot"
    if ! { docker start "$SHOP_NAME" > /dev/null 2>&1 && wait_ready "$SHOP_NAME"; }; then
      log "it does not start: $(log_tail "$SHOP_NAME")"
      restore_carried
      return 1
    fi
  fi
  # The image it runs, re-created with the full definition: the same checked switch.
  ad_rc=0
  single_switch "$(container_image "$SHOP_NAME")" "set-up" || ad_rc=$?
  if [ "$ad_rc" != 0 ]; then restore_carried; fi
  return "$ad_rc"
}

# The shop container runs but was not started from this definition (e.g. by hand, with the
# old podman pull/stop/rm/run routine: no request and status volumes). It is set up again,
# keeping what it has, once per container: a container that cannot be carried is not retried.
reapply_spec() {
  ra_id=$(docker inspect -f '{{.Id}}' "$SHOP_NAME" 2> /dev/null) || return 0
  if grep -Fxq -e "$ra_id" "$STATE_DIR/spec-tried" 2> /dev/null; then return 0; fi
  printf '%s\n' "$ra_id" > "$STATE_DIR/spec-tried"
  log "$SHOP_NAME was not started by the updater (its settings label differs); setting it up again with the same image"
  ra_rc=0
  adopt || ra_rc=$?
  case $ra_rc in
    0) ;;
    2) alert error "$SHOP_NAME was started by hand with settings the updater cannot carry over (see the updater log), so Settings → Versions cannot reach the updater. Stop the updater before updating by hand, or use Update to the latest." ;;
    *) alert error "$SHOP_NAME was started by hand and could not be set up again; it keeps running as it is (see the updater log)." ;;
  esac
  return 0
}

single_status() {
  for st_name in "$SHOP_NAME" "$CANDIDATE" "$PREVIOUS_NAME"; do
    if st_state=$(state_of "$st_name"); then
      echo "$st_name: $st_state, image $(describe "$(container_image "$st_name")"), data volume $(data_volume_of "$st_name")"
    elif [ "$st_name" = "$SHOP_NAME" ]; then
      echo "$st_name: not created"
    fi
  done
}

# ── Update: pull, compare, switch ───────────────────────────────────────────

update_once() {
  log "checking $IMAGE for a new version"
  if ! docker pull -q "$IMAGE" > /dev/null 2>&1; then
    log "could not pull $IMAGE; using the copy on this server, if any"
  fi
  up_new=$(image_id "$IMAGE") || {
    log "no image $IMAGE on this server"
    return 2
  }
  up_cid=$(serving_cid)
  [ -n "$up_cid" ] || return 2
  up_old=$(container_image "$up_cid")
  if same_image "$up_new" "$up_old"; then
    log "up to date: $(serving_name) runs $(describe "$up_new")"
    return 0
  fi
  if is_bad "$up_new"; then
    log "skipping $(describe "$up_new"): it failed before; waiting for a newer image"
    return 0
  fi
  switch_image "$IMAGE" "update"
}

# ── Self-healing ─────────────────────────────────────────────────────────────

# Start COLOUR from the last good image as the only copy. 0 when it serves.
recover_with() {
  rec_ref=$(last_good_ref)
  if ! start_colour "$1" "$rec_ref"; then return 1; fi
  rec_cid=$(cid_of "$1")
  if wait_ready "$rec_cid" && probe_page "$rec_cid"; then
    printf '%s\n' "$1" > "$STATE_DIR/active"
    return 0
  fi
  remove_colour "$1"
  return 1
}

heal_once() {
  if is_single; then
    single_heal
    return
  fi
  heal_blue=$(cid_of blue)
  heal_green=$(cid_of green)

  if [ -z "$heal_blue" ] && [ -z "$heal_green" ]; then
    heal_colour=$(recorded_active)
    alert error "no copy of the shop was running; starting app-$heal_colour from $(last_good_ref)"
    if recover_with "$heal_colour"; then
      alert info "recovered: app-$heal_colour serves again"
      return 0
    fi
    heal_colour=$(other "$heal_colour")
    if recover_with "$heal_colour"; then
      alert info "recovered: app-$heal_colour serves again"
      return 0
    fi
    alert critical "the shop is down: neither copy starts from $(last_good_ref). See: docker compose logs app-blue app-green"
    return 1
  fi

  if [ -n "$heal_blue" ] && [ -n "$heal_green" ]; then
    heal_keep=$(recorded_active)
    heal_drop=$(other "$heal_keep")
    if [ "$(health_of "$(cid_of "$heal_keep")")" = unhealthy ] && [ "$(health_of "$(cid_of "$heal_drop")")" = healthy ]; then
      heal_keep=$heal_drop
      heal_drop=$(other "$heal_keep")
    fi
    log "both copies are running; keeping app-$heal_keep, stopping app-$heal_drop"
    printf '%s\n' "$heal_keep" > "$STATE_DIR/active"
    stop_colour "$heal_drop"
    return 0
  fi

  heal_active=$(running_colour)
  heal_cid=$(cid_of "$heal_active")
  printf '%s\n' "$heal_active" > "$STATE_DIR/active"
  heal_health=$(health_of "$heal_cid")

  if [ "$heal_health" = healthy ]; then
    printf '0\n' > "$STATE_DIR/unhealthy-count"
    # First run: the copy that serves well is the last good one.
    if ! image_id "$LAST_GOOD" > /dev/null; then
      heal_img=$(container_image "$heal_cid")
      remember_good "$heal_img"
      log "recorded $(describe "$heal_img") as $LAST_GOOD"
    fi
    return 0
  fi
  if [ "$heal_health" != unhealthy ]; then
    return 0 # starting: give it time
  fi

  heal_count=$(cat "$STATE_DIR/unhealthy-count" 2> /dev/null || echo 0)
  is_number "$heal_count" || heal_count=0
  heal_count=$((heal_count + 1))
  printf '%s\n' "$heal_count" > "$STATE_DIR/unhealthy-count"
  log "app-$heal_active is unhealthy ($heal_count of $UNHEALTHY_LIMIT checks)"
  [ "$heal_count" -ge "$UNHEALTHY_LIMIT" ] || return 0

  printf '0\n' > "$STATE_DIR/unhealthy-count"
  alert warning "app-$heal_active was unhealthy for $heal_count checks in a row; restarting it"
  docker restart -t "$STOP_TIMEOUT" "$heal_cid" > /dev/null 2>&1 || true
  if wait_ready "$heal_cid"; then
    alert info "app-$heal_active is healthy again after a restart"
    return 0
  fi

  heal_other=$(other "$heal_active")
  alert error "app-$heal_active is still unhealthy after a restart; starting app-$heal_other from $(last_good_ref)"
  remove_colour "$heal_other"
  if recover_with "$heal_other"; then
    stop_colour "$heal_active" 10
    alert info "recovered: app-$heal_other serves $(describe "$(container_image "$(cid_of "$heal_other")")"); app-$heal_active is stopped for inspection (docker compose logs app-$heal_active)"
    return 0
  fi
  alert critical "app-$heal_other did not start from $(last_good_ref) either; app-$heal_active is left running. See: docker compose logs app-blue app-green"
  return 1
}

# ── Rollback to a given image, the same zero-downtime way ───────────────────────

# rollback_to REF: 0 switched (or already running), 1 the image failed, 2 refused or error.
rollback_to() {
  rb_ref=$1
  # A published version (ghcr.io/cxsmtp/buh:1.2.0) is fetched first if it is not here yet.
  image_id "$rb_ref" > /dev/null || docker pull -q "$rb_ref" > /dev/null 2>&1 || true
  if ! image_id "$rb_ref" > /dev/null; then
    log "rollback: $rb_ref could not be found or downloaded"
    return 2
  fi
  # Versions before 2.0.0 keep stock as one number per product, not per size: on today's
  # database they would refuse orders (stock guard). Refuse them unless forced.
  rb_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$rb_ref" 2>/dev/null || true)
  case $rb_version in
    0.* | 1.*)
      if [ "${FORCE_OLD_SCHEMA:-0}" != 1 ]; then
        log "refusing to roll back to $rb_version: versions before 2.0.0 cannot run on this database (restore the pre-update snapshot instead, or set FORCE_OLD_SCHEMA=1)"
        return 2
      fi
      ;;
  esac
  rb_cid=$(serving_cid)
  if [ -n "$rb_cid" ]; then
    rb_current=$(container_image "$rb_cid")
    if same_image "$(image_id "$rb_ref")" "$rb_current"; then
      log "already running $rb_ref"
      return 0
    fi
    # Keep automatic updates from bringing the rolled-back version straight back.
    remember_bad "$rb_current"
  fi
  switch_image "$rb_ref" "rollback to $rb_ref"
}

# ── Requests from the Admin Hub, and the status it shows ──────────────────────

# The image name without its tag: ghcr.io/cxsmtp/buh:latest -> ghcr.io/cxsmtp/buh.
image_repo() {
  case ${IMAGE##*/} in
    *:*) printf '%s' "${IMAGE%:*}" ;;
    *) printf '%s' "$IMAGE" ;;
  esac
}

version_of() {
  vo=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true)
  case $vo in '<no value>') vo='' ;; esac
  printf '%s' "$vo"
}

last_request=''
last_result=''
last_message=''
last_at=''

# One request at most. It is first moved into a new folder only root can open (same
# filesystem, so the move is a rename), so the shop can't swap it for a link or a pipe
# while it is read; then it must be a small plain file holding one known line.
take_request() {
  [ -d "$CONTROL_DIR" ] && [ ! -L "$CONTROL_DIR" ] || return 0
  [ -e "$CONTROL_DIR/request" ] || [ -L "$CONTROL_DIR/request" ] || return 0
  rq_dir=$(mktemp -d "$CONTROL_DIR/.taken.XXXXXX") || return 0
  if ! mv "$CONTROL_DIR/request" "$rq_dir/request" 2> /dev/null; then
    rm -rf "$rq_dir"
    return 0
  fi
  rq_line=''
  if [ ! -L "$rq_dir/request" ] && [ -f "$rq_dir/request" ] && [ "$(wc -c < "$rq_dir/request")" -le 64 ]; then
    rq_line=$(head -c 64 "$rq_dir/request" | head -n 1 | tr -d '\r')
  fi
  rm -rf "$rq_dir"
  last_at=$(stamp)
  if printf '%s' "$rq_line" | grep -Eqx 'rollback [0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'; then
    last_request=$rq_line
    rq_version=${rq_line#rollback }
    log "Admin Hub asked to switch to version $rq_version"
    last_result=working last_message="Switching to $rq_version…"
    publish_status
    rq_rc=0
    rollback_to "$(image_repo):$rq_version" || rq_rc=$?
    case $rq_rc in
      0) last_result=ok last_message="The shop runs $rq_version." ;;
      1) last_result=failed last_message="$rq_version did not start properly; the shop stays on the version it was running." ;;
      *) last_result=refused last_message="$rq_version could not be used (not published, or older than 2.0.0, which cannot run on this database). See the updater log." ;;
    esac
  elif [ "$rq_line" = update ]; then
    last_request=update
    log "Admin Hub asked for the latest version"
    last_result=working last_message="Fetching and starting the latest version…"
    publish_status
    docker pull -q "$IMAGE" > /dev/null 2>&1 || true
    # Asked for by a person: give an image that was rolled back from another chance.
    if rq_latest=$(image_id "$IMAGE"); then forget_bad "$rq_latest"; fi
    rq_rc=0
    update_once || rq_rc=$?
    case $rq_rc in
      0) last_result=ok last_message="The shop runs the latest version." ;;
      1) last_result=failed last_message="The latest version did not start properly; the shop stays on the version it was running." ;;
      *) last_result=failed last_message="The latest version could not be fetched. See the updater log." ;;
    esac
  else
    # Never echo what was there: it was not one of ours.
    log "ignored a request that was not a known line in a small plain file"
    last_request='(not understood)'
    last_result=refused
    last_message="Unknown request."
  fi
}

# What runs, the versions on this server and the last request, for the Admin Hub.
publish_status() {
  [ -d "$PUBLIC_DIR" ] && [ ! -L "$PUBLIC_DIR" ] || return 0
  ps_cid=$(serving_cid)
  ps_running=''
  [ -z "$ps_cid" ] || ps_running=$(version_of "$(container_image "$ps_cid")")
  ps_good=''
  image_id "$LAST_GOOD" > /dev/null && ps_good=$(version_of "$LAST_GOOD")
  ps_prev=''
  image_id "$PREVIOUS" > /dev/null && ps_prev=$(version_of "$PREVIOUS")
  ps_versions=''
  for ps_id in $(docker image ls -q --filter "label=$IMAGE_SOURCE_LABEL" 2>/dev/null | sort -u); do
    ps_v=$(version_of "$ps_id")
    if printf '%s' "$ps_v" | grep -Eqx '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'; then
      case ",$ps_versions," in *",\"$ps_v\","*) ;; *) ps_versions="${ps_versions:+$ps_versions,}\"$ps_v\"" ;; esac
    fi
  done
  ps_minutes=$(setting UPDATE_CHECK_MINUTES 15)
  is_number "$ps_minutes" || ps_minutes=15
  # Written to a new file, then renamed over the old one: a link planted there is replaced, never followed.
  ps_tmp=$(mktemp "$PUBLIC_DIR/.status.XXXXXX") || return 0
  ps_mode=compose
  if is_single; then ps_mode=single; fi
  printf '{"updatedAt":"%s","mode":"%s","running":"%s","lastGood":"%s","previous":"%s","onServer":[%s],"autoUpdateMinutes":%s,"lastRequest":{"request":"%s","result":"%s","message":"%s","at":"%s"}}\n' \
    "$(stamp)" "$ps_mode" "$(json_escape "$ps_running")" "$(json_escape "$ps_good")" "$(json_escape "$ps_prev")" "$ps_versions" "$ps_minutes" \
    "$(json_escape "$last_request")" "$last_result" "$(json_escape "$last_message")" "$last_at" > "$ps_tmp"
  chmod 644 "$ps_tmp" 2>/dev/null || true
  mv -f "$ps_tmp" "$PUBLIC_DIR/status.json"
}

# ── Commands ─────────────────────────────────────────────────────────────────

stop_requested=0
on_term() {
  stop_requested=1
}

daemon() {
  minutes=$(setting UPDATE_CHECK_MINUTES 15)
  if ! is_number "$minutes"; then
    log "UPDATE_CHECK_MINUTES=$minutes is not a whole number; using 15"
    minutes=15
  fi
  is_number "$HEAL_CHECK_SECONDS" && [ "$HEAL_CHECK_SECONDS" -gt 0 ] || HEAL_CHECK_SECONDS=30
  if is_single; then
    started_what="one container $SHOP_NAME on port $SHOP_PORTS, data in $SHOP_VOLUME"
  else
    started_what="project $PROJECT"
  fi
  if [ "$minutes" = 0 ]; then
    log "updater started ($started_what, image $IMAGE): updates only on demand; health checked every ${HEAL_CHECK_SECONDS}s"
  else
    log "updater started ($started_what, image $IMAGE): updates every $minutes min; health checked every ${HEAL_CHECK_SECONDS}s"
  fi
  trap on_term TERM INT
  next_update=$(now)
  while [ "$stop_requested" = 0 ]; do
    if lock; then
      heal_once || true
      due=0
      if [ -f "$STATE_DIR/update-now" ]; then
        rm -f "$STATE_DIR/update-now"
        log "update requested"
        due=1
      fi
      if [ "$minutes" -gt 0 ] && [ "$(now)" -ge "$next_update" ]; then
        due=1
        next_update=$(($(now) + minutes * 60))
      fi
      if [ "$due" = 1 ] && [ "$stop_requested" = 0 ]; then
        update_once || true
      fi
      [ "$stop_requested" = 1 ] || take_request
      publish_status
      unlock
    fi
    [ "$stop_requested" = 0 ] || break
    sleep "$HEAL_CHECK_SECONDS" &
    wait $! || true
  done
  log "updater stopped"
}

status() {
  if is_single; then single_status; fi
  for st_colour in blue green; do
    is_single && break
    st_cid=$(cid_of "$st_colour" all)
    if [ -z "$st_cid" ]; then
      echo "app-$st_colour: not created"
    else
      st_state=$(docker inspect -f '{{.State.Status}}' "$st_cid")
      [ "$st_state" != running ] || st_state="running, $(health_of "$st_cid")"
      echo "app-$st_colour: $st_state, image $(describe "$(container_image "$st_cid")")"
    fi
  done
  if image_id "$LAST_GOOD" > /dev/null; then echo "last good: $(describe "$(image_id "$LAST_GOOD")")"; else echo "last good: not recorded yet"; fi
  if image_id "$PREVIOUS" > /dev/null; then echo "previous:  $(describe "$(image_id "$PREVIOUS")")"; fi
  if [ -s "$STATE_DIR/bad-images" ]; then
    echo "rejected images:"
    while IFS= read -r st_bad; do echo "  $(short "$st_bad")"; done < "$STATE_DIR/bad-images"
  fi
  echo "recent log:"
  tail -n 20 "$STATE_DIR/updater.log" 2> /dev/null || true
}

main() {
  mkdir -p "$STATE_DIR"
  if [ -f "$STATE_DIR/updater.log" ] && [ "$(wc -c < "$STATE_DIR/updater.log")" -gt 5242880 ]; then
    mv "$STATE_DIR/updater.log" "$STATE_DIR/updater.log.1"
  fi
  case $UPDATER_MODE in
    single)
      check_single_settings || exit 2
      # No compose project: settings come from the environment only.
      cd "$PROJECT_DIR" 2> /dev/null || cd /
      ;;
    compose)
      cd "$PROJECT_DIR" || {
        echo "the compose project is not mounted at $PROJECT_DIR" >&2
        exit 2
      }
      PROJECT=${COMPOSE_PROJECT_NAME:-$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(hostname)" 2> /dev/null || true)}
      if [ -z "$PROJECT" ] || [ "$PROJECT" = '<no value>' ]; then
        echo "cannot tell the compose project; run this as the compose service, or set COMPOSE_PROJECT_NAME" >&2
        exit 2
      fi
      ;;
    *)
      echo "UPDATER_MODE must be compose (the default) or single" >&2
      exit 2
      ;;
  esac
  unset BUH_IMAGE
  # The shop (another user) may create its request file here but not remove others' (sticky)
  # nor list the folder; the updater owns it, so it can read and remove requests.
  if [ -d "$CONTROL_DIR" ] && [ ! -L "$CONTROL_DIR" ]; then chmod 1733 "$CONTROL_DIR" 2>/dev/null || true; fi

  cmd=${1:-daemon}
  if [ "$cmd" = daemon ] && [ "$ONE_SHOT" = 1 ]; then cmd=once; fi
  case $cmd in
    daemon)
      daemon
      ;;
    once | update-now)
      wait_for_lock || exit 2
      trap unlock EXIT
      rc=0
      heal_once || rc=2
      if [ "$rc" = 0 ]; then
        update_once || rc=$?
      fi
      exit "$rc"
      ;;
    heal)
      wait_for_lock || exit 2
      trap unlock EXIT
      heal_once
      ;;
    rollback)
      wait_for_lock || exit 2
      trap unlock EXIT
      rollback_to "${2:-$PREVIOUS}"
      ;;
    adopt)
      if ! is_single; then
        echo "adopt is for UPDATER_MODE=single" >&2
        exit 2
      fi
      wait_for_lock || exit 2
      trap unlock EXIT
      adopt
      ;;
    status)
      status
      ;;
    *)
      echo "usage: updater.sh [daemon | once | update-now | heal | rollback [image] | status | adopt]" >&2
      exit 2
      ;;
  esac
}

main "$@"
