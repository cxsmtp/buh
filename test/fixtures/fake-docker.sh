#!/bin/sh
# A stand-in for the docker CLI, for test/updater.test.mts: just enough of ps, inspect,
# image inspect, pull, tag, exec, compose up, run, start, rename, stop, rm, restart, volume
# inspect and logs to drive deploy/updater/updater.sh without a Docker daemon.
# State lives in $FAKE_DOCKER_DIR:
#   tags/<ref>          image id a tag points to (refs with / and : flattened)
#   registry/<ref>      image id `docker pull <ref>` fetches
#   c/<name>/image      a container's image id. Compose copies are c/blue and c/green
#                       (container id cid-<colour>); single-mode containers go by name.
#   c/<name>/status     running | exited | created
#   c/<name>/health     healthy | unhealthy | starting (overrides the image's behaviour)
#   c/<name>/data       single mode: the volume at /data; port: the host port; spec: its label;
#                       args: the whole `docker run` command line
#   vols/<volume>       a volume that exists
#   ids                 every image id on the "server"
#   backup-fails        present: the database snapshot fails
#   port-fails          present: `docker run -p …` cannot start (the container stays "created")
#   events              one line per action, in order
# Image ids containing "broken" never become healthy; "crash" exits at once.
set -u
D=$FAKE_DOCKER_DIR
mkdir -p "$D/tags" "$D/c" "$D/registry" "$D/vols"
ev() { printf '%s\n' "$*" >> "$D/events"; }
key() { printf '%s' "$1" | tr '/:@' '___'; }
resolve() {
  case $1 in sha256:*) grep -qx "$1" "$D/ids" 2> /dev/null && echo "$1" && return 0; return 1 ;; esac
  # A bare id (the updater drops the prefix when it starts or tags an image by id).
  grep -qx "sha256:$1" "$D/ids" 2> /dev/null && echo "sha256:$1" && return 0
  [ -f "$D/tags/$(key "$1")" ] && cat "$D/tags/$(key "$1")"
}
colour_of() { printf '%s' "$1" | sed 's/^cid-//'; }
# How a container shows in events: app-<colour> for compose copies, else its name.
label_of() { case $1 in cid-*) echo "app-${1#cid-}" ;; *) echo "$1" ;; esac; }
health_for() {
  case $1 in *crash*) echo crash ;; *broken*) echo unhealthy ;; *) echo healthy ;; esac
}
# start_as DIR: running, or exited for an image that crashes.
start_as() {
  rm -f "$1/health"
  if [ "$(health_for "$(cat "$1/image")")" = crash ]; then echo exited > "$1/status"; else echo running > "$1/status"; fi
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
      *RestartCount*) echo "$st 0 $h" ;;
      *Health*) echo "$st $h" ;;
      *Mounts*) cat "$D/c/$c/data" 2> /dev/null || echo ;;
      *buh.updater.spec*) cat "$D/c/$c/spec" 2> /dev/null || echo '<no value>' ;;
      *) exit 1 ;;
    esac
    ;;
  image)
    case $1 in
      inspect)
        fmt=$3
        id=$(resolve "$4") || exit 1
        case $fmt in
          '{{.Id}}') echo "$id" ;;
          *image.version*) cat "$D/versions/$id" 2> /dev/null || echo '<no value>' ;;
          *) echo '<no value>' ;;
        esac
        ;;
      prune) ev "prune" ;;
      ls) cat "$D"/tags/* 2> /dev/null | sort -u ;;
    esac
    ;;
  volume)
    # docker volume inspect NAME
    [ "$1" = inspect ] && [ -f "$D/vols/$2" ]
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
    who=$(label_of "$1")
    c=$(colour_of "$1")
    shift
    [ "$(cat "$D/c/$c/status" 2> /dev/null)" = running ] || exit 1
    case "$*" in
      'test -f scripts/backup-now.mjs') exit 0 ;;
      'node scripts/backup-now.mjs')
        [ -f "$D/backup-fails" ] && { echo "disk full"; exit 1; }
        ev "backup $who"
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
    start_as "$D/c/$c"
    ev "up app-$c $id"
    ;;
  run)
    # docker run -d --name N [--label k=v] [--restart p -p HOST:3000] -v … -e … … IMAGE
    args="$*"
    name='' port='' data='' spec='' image=''
    while [ $# -gt 0 ]; do
      case $1 in
        -d | --read-only) ;;
        --name) name=$2 && shift ;;
        --label) case $2 in buh.updater.spec=*) spec=${2#*=} ;; esac && shift ;;
        -p) port=${2%%:*} && shift ;;
        -v) case $2 in *:/data) data=${2%%:*} ;; esac && shift ;;
        -e | --restart | --tmpfs | --cap-drop | --security-opt | --pids-limit) shift ;;
        -*) echo "fake docker: unknown run flag $1" >&2 && exit 125 ;;
        *) image=$1 ;;
      esac
      shift
    done
    id=$(resolve "$image") || { echo "Unable to find image '$image'"; exit 125; }
    [ -e "$D/c/$name" ] && { echo "the container name \"$name\" is already in use"; exit 125; }
    mkdir -p "$D/c/$name"
    printf '%s\n' "$id" > "$D/c/$name/image"
    printf '%s\n' "$args" > "$D/c/$name/args"
    printf '%s\n' "$data" > "$D/c/$name/data"
    printf '%s\n' "$spec" > "$D/c/$name/spec"
    printf '%s\n' "$port" > "$D/c/$name/port"
    [ -z "$data" ] || touch "$D/vols/$data"
    ev "run $name $id${port:+ port=$port}"
    if [ -n "$port" ]; then
      busy=''
      [ -f "$D/port-fails" ] && busy=1
      for other in "$D"/c/*; do
        [ "$other" != "$D/c/$name" ] && [ "$(cat "$other/port" 2> /dev/null)" = "$port" ] &&
          [ "$(cat "$other/status")" = running ] && busy=1
      done
      if [ -n "$busy" ]; then
        echo created > "$D/c/$name/status"
        echo "Error: cannot listen on the TCP port: listen tcp4 :$port: bind: address already in use"
        exit 125
      fi
    fi
    start_as "$D/c/$name"
    ;;
  start)
    [ -f "$D/c/$1/image" ] || exit 1
    start_as "$D/c/$1"
    ev "start $1"
    [ "$(cat "$D/c/$1/status")" = running ]
    ;;
  rename)
    [ -d "$D/c/$1" ] && [ ! -e "$D/c/$2" ] || exit 1
    mv "$D/c/$1" "$D/c/$2"
    ev "rename $1 $2"
    ;;
  stop)
    c=$(colour_of "$3")
    [ -f "$D/c/$c/image" ] || exit 1
    echo exited > "$D/c/$c/status"
    ev "stop $(label_of "$3")"
    ;;
  restart)
    c=$(colour_of "$3")
    echo running > "$D/c/$c/status"
    [ -f "$D/c/$c/sick-after-restart" ] || rm -f "$D/c/$c/health"
    ev "restart $(label_of "$3")"
    ;;
  rm)
    [ "$1" = -f ] && shift
    c=$(colour_of "$1")
    [ -d "$D/c/$c" ] || exit 1
    rm -rf "${D:?}/c/$c"
    ev "rm $(label_of "$1")"
    ;;
  logs) echo "fake log line" ;;
  *) echo "fake docker: unsupported $cmd" >&2; exit 1 ;;
esac
