#!/bin/sh
# A stand-in for the docker CLI, for test/updater.test.mts: just enough of ps, inspect,
# image inspect, pull, tag, exec, compose up, stop, rm, restart and logs to drive
# deploy/updater/updater.sh without a Docker daemon. State lives in $FAKE_DOCKER_DIR:
#   tags/<ref>          image id a tag points to (refs with / and : flattened)
#   registry/<ref>      image id `docker pull <ref>` fetches
#   c/<colour>/image    container app-<colour>: its image id
#   c/<colour>/status   running | exited
#   c/<colour>/health   healthy | unhealthy | starting (overrides the image's behaviour)
#   ids                 every image id on the "server"
#   backup-fails        present: the database snapshot fails
#   events              one line per action, in order
# Image ids containing "broken" never become healthy; "crash" exits at once.
set -u
D=$FAKE_DOCKER_DIR
mkdir -p "$D/tags" "$D/c" "$D/registry"
ev() { printf '%s\n' "$*" >> "$D/events"; }
key() { printf '%s' "$1" | tr '/:@' '___'; }
resolve() {
  case $1 in sha256:*) grep -qx "$1" "$D/ids" 2> /dev/null && echo "$1" && return 0; return 1 ;; esac
  [ -f "$D/tags/$(key "$1")" ] && cat "$D/tags/$(key "$1")"
}
colour_of() { printf '%s' "$1" | sed 's/^cid-//'; }
health_for() {
  case $1 in *crash*) echo crash ;; *broken*) echo unhealthy ;; *) echo healthy ;; esac
}

cmd=$1
shift
case $cmd in
  ps)
    all=0 service=''
    for a in "$@"; do
      case $a in -aq) all=1 ;; label=com.docker.compose.service=*) service=${a#label=com.docker.compose.service=} ;; esac
    done
    c=${service#app-}
    [ -f "$D/c/$c/image" ] || exit 0
    if [ "$all" = 1 ] || [ "$(cat "$D/c/$c/status")" = running ]; then echo "cid-$c"; fi
    ;;
  inspect)
    fmt=$2
    c=$(colour_of "$3")
    [ -f "$D/c/$c/image" ] || exit 1
    st=$(cat "$D/c/$c/status")
    h=$(cat "$D/c/$c/health" 2> /dev/null || health_for "$(cat "$D/c/$c/image")")
    [ "$h" = crash ] && h=unhealthy
    case $fmt in
      '{{.Image}}') cat "$D/c/$c/image" ;;
      '{{.RestartCount}}') echo 0 ;;
      '{{.State.Status}}') echo "$st" ;;
      *RestartCount*) echo "$st $h 0" ;;
      *Health*) echo "$st $h" ;;
      *) exit 1 ;;
    esac
    ;;
  image)
    case $1 in
      inspect)
        fmt=$3
        id=$(resolve "$4") || exit 1
        case $fmt in '{{.Id}}') echo "$id" ;; *) echo '<no value>' ;; esac
        ;;
      prune) ev "prune" ;;
    esac
    ;;
  pull)
    ref=$2
    [ -f "$D/registry/$(key "$ref")" ] || exit 1
    cp "$D/registry/$(key "$ref")" "$D/tags/$(key "$ref")"
    ev "pull $ref"
    ;;
  tag)
    id=$(resolve "$1") || exit 1
    printf '%s\n' "$id" > "$D/tags/$(key "$2")"
    ev "tag $2 $id"
    ;;
  exec)
    [ "$1" = -i ] && shift
    c=$(colour_of "$1")
    shift
    [ "$(cat "$D/c/$c/status" 2> /dev/null)" = running ] || exit 1
    case "$*" in
      'test -f scripts/backup-now.mjs') exit 0 ;;
      'node scripts/backup-now.mjs')
        [ -f "$D/backup-fails" ] && { echo "disk full"; exit 1; }
        ev "backup app-$c"
        echo /data/backups/pre-update-20261015-000000.db
        ;;
      *api/health*)
        h=$(cat "$D/c/$c/health" 2> /dev/null || health_for "$(cat "$D/c/$c/image")")
        [ "$h" = healthy ] && echo '{"ok":true}'
        ;;
      *http://127.0.0.1:3000/*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  compose)
    # docker compose -p P up -d --no-deps --pull never app-<colour>
    service=''
    for a in "$@"; do service=$a; done
    c=${service#app-}
    id=$(resolve "${BUH_IMAGE:-ghcr.io/cxsmtp/buh:latest}") || { echo "no such image"; exit 1; }
    mkdir -p "$D/c/$c"
    printf '%s\n' "$id" > "$D/c/$c/image"
    rm -f "$D/c/$c/health"
    if [ "$(health_for "$id")" = crash ]; then echo exited > "$D/c/$c/status"; else echo running > "$D/c/$c/status"; fi
    ev "up app-$c $id"
    ;;
  stop)
    c=$(colour_of "$3")
    echo exited > "$D/c/$c/status"
    ev "stop app-$c"
    ;;
  restart)
    c=$(colour_of "$3")
    echo running > "$D/c/$c/status"
    [ -f "$D/c/$c/sick-after-restart" ] || rm -f "$D/c/$c/health"
    ev "restart app-$c"
    ;;
  rm)
    c=$(colour_of "$1")
    rm -rf "${D:?}/c/$c"
    ev "rm app-$c"
    ;;
  logs) echo "fake log line" ;;
  *) echo "fake docker: unsupported $cmd" >&2; exit 1 ;;
esac
