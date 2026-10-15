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
#
# Settings: UPDATE_CHECK_MINUTES (default 15; 0 = only on demand) and ALERT_WEBHOOK_URL are
# read from the environment, else from .env.production (only those two keys).
# Test/CI overrides (environment only): IMAGE, ONE_SHOT=1, HEALTH_TIMEOUT, SETTLE_SECONDS,
# HEAL_CHECK_SECONDS, UNHEALTHY_LIMIT, STOP_TIMEOUT.
set -u

PROJECT_DIR=${PROJECT_DIR:-/project}
STATE_DIR=${STATE_DIR:-/state}
ALERT_DIR=${ALERT_DIR:-/state/alerts}
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
  case $health_line in
    running\ *) echo "${health_line#running }" ;;
    *) echo unhealthy ;;
  esac
}

# The app answers /api/health with {"ok":true} (asked inside the container).
probe_health() {
  docker exec "$1" wget -q -T 5 -O - http://127.0.0.1:3000/api/health 2> /dev/null | grep -q '"ok":true'
}

# The storefront renders (busybox wget fails on anything but 2xx).
probe_page() {
  docker exec "$1" wget -q -T 20 -O /dev/null http://127.0.0.1:3000/ 2> /dev/null
}

# Wait until the container's own healthcheck says healthy and the app answers.
# Gives up at once if it exits or crash-loops, else after HEALTH_TIMEOUT seconds.
wait_ready() {
  ready_cid=$1
  ready_deadline=$(($(now) + HEALTH_TIMEOUT))
  ready_restarts=$(docker inspect -f '{{.RestartCount}}' "$ready_cid" 2> /dev/null || echo 0)
  while [ "$(now)" -lt "$ready_deadline" ]; do
    ready_line=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$ready_cid" 2> /dev/null) || {
      log "the container disappeared"
      return 1
    }
    read -r ready_status ready_health ready_count << EOF
$ready_line
EOF
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
  docker tag "$1" "$LAST_GOOD" > /dev/null
  printf '%s\n' "$1" > "$STATE_DIR/last-good"
  # A manual switch to an image clears an earlier rejection of it.
  if [ -f "$STATE_DIR/bad-images" ]; then
    grep -vx "$1" "$STATE_DIR/bad-images" > "$STATE_DIR/bad-images.tmp" || true
    mv "$STATE_DIR/bad-images.tmp" "$STATE_DIR/bad-images"
  fi
}

remember_bad() {
  grep -qx "$1" "$STATE_DIR/bad-images" 2> /dev/null || printf '%s\n' "$1" >> "$STATE_DIR/bad-images"
}

is_bad() {
  grep -qx "$1" "$STATE_DIR/bad-images" 2> /dev/null
}

last_good_ref() {
  if image_id "$LAST_GOOD" > /dev/null; then echo "$LAST_GOOD"; else echo "$IMAGE"; fi
}

# ── Backup before switching ──────────────────────────────────────────────────

backup_in() {
  if docker exec "$1" test -f scripts/backup-now.mjs; then
    docker exec "$1" node scripts/backup-now.mjs 2>&1
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
    if [ "$(container_image "$sw_cid")" != "$sw_new" ]; then
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
  up_active=$(running_colour)
  [ -n "$up_active" ] || return 2
  up_old=$(container_image "$(cid_of "$up_active")")
  if [ "$up_new" = "$up_old" ]; then
    log "up to date: app-$up_active runs $(describe "$up_new")"
    return 0
  fi
  if is_bad "$up_new"; then
    log "skipping $(describe "$up_new"): it failed before; waiting for a newer image"
    return 0
  fi
  switch_to "$IMAGE" "update"
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
  if [ "$minutes" = 0 ]; then
    log "updater started (project $PROJECT, image $IMAGE): updates only on demand; health checked every ${HEAL_CHECK_SECONDS}s"
  else
    log "updater started (project $PROJECT, image $IMAGE): updates every $minutes min; health checked every ${HEAL_CHECK_SECONDS}s"
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
      unlock
    fi
    [ "$stop_requested" = 0 ] || break
    sleep "$HEAL_CHECK_SECONDS" &
    wait $! || true
  done
  log "updater stopped"
}

status() {
  for st_colour in blue green; do
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
  cd "$PROJECT_DIR" || {
    echo "the compose project is not mounted at $PROJECT_DIR" >&2
    exit 2
  }
  PROJECT=${COMPOSE_PROJECT_NAME:-$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(hostname)" 2> /dev/null || true)}
  if [ -z "$PROJECT" ] || [ "$PROJECT" = '<no value>' ]; then
    echo "cannot tell the compose project; run this as the compose service, or set COMPOSE_PROJECT_NAME" >&2
    exit 2
  fi
  unset BUH_IMAGE

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
      rb_ref=${2:-$PREVIOUS}
      # A published version (ghcr.io/cxsmtp/buh:1.2.0) is fetched first if it is not here yet.
      image_id "$rb_ref" > /dev/null || docker pull -q "$rb_ref" > /dev/null 2>&1 || true
      # Versions before 2.0.0 keep stock as one number per product, not per size: on today's
      # database they would refuse orders (stock guard). Refuse them unless forced.
      rb_version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$rb_ref" 2>/dev/null || true)
      case $rb_version in
        0.* | 1.*)
          if [ "${FORCE_OLD_SCHEMA:-0}" != 1 ]; then
            log "refusing to roll back to $rb_version: versions before 2.0.0 cannot run on this database (restore the pre-update snapshot instead, or set FORCE_OLD_SCHEMA=1)"
            exit 2
          fi
          ;;
      esac
      rb_active=$(running_colour)
      if [ -n "$rb_active" ]; then
        rb_current=$(container_image "$(cid_of "$rb_active")")
        if [ "$(image_id "$rb_ref")" = "$rb_current" ]; then
          log "already running $rb_ref"
          exit 0
        fi
        # Keep automatic updates from bringing the rolled-back version straight back.
        remember_bad "$rb_current"
      fi
      switch_to "$rb_ref" "rollback to $rb_ref"
      ;;
    status)
      status
      ;;
    *)
      echo "usage: updater.sh [daemon | once | update-now | heal | rollback [image] | status]" >&2
      exit 2
      ;;
  esac
}

main "$@"
