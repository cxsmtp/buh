#!/bin/sh
# A stand-in for the docker CLI, for test/updater.test.mts: just enough of ps, inspect,
# image inspect, pull, tag, exec, compose up, run, start, rename, stop, rm, restart, volume
# inspect and logs to drive deploy/updater/updater.sh without a Docker daemon.
# State lives in $FAKE_DOCKER_DIR:
#   tags/<ref>          image id a tag points to (refs with / and : flattened)
#   registry/<ref>      image id `docker pull <ref>` fetches (<ref> may be repo@sha256:…)
#   registry-digest/<ref>  the digest a tag is published under (sha256:…): RepoDigests after a pull
#   digests/<id>        an image's RepoDigests (repo@sha256:… lines)
#   c/<name>/image      a container's image id. Compose copies are c/blue and c/green
#                       (container id cid-<colour>); single-mode containers go by name.
#   c/<name>/status     running | exited | created
#   c/<name>/health     healthy | unhealthy | starting (overrides the image's behaviour)
#   c/<name>/data       single mode: the volume at /data; port: the (first) host port; spec: its
#                       label; args: the whole `docker run` command line; env: its environment
#                       (one entry a line; envcount overrides the count, as for a value with a
#                       line break); envfile: the --env-file it got; bindings: "3000/tcp|IP|PORT"
#                       lines; mounts: "TYPE|NAME|SOURCE|DEST" lines
#   image-env           the image's own environment (default: a few lines like the shop image's)
#   volumes/<volume>/   the contents of a volume an updater container mounts (/state, /control, /public)
#   rootful             present: `docker info` reports a rootful engine (default rootless)
# Images whose id contains "upd" are the buh-updater image: `run --rm` of one runs
# $FAKE_UPDATER_SH with the container's environment and volumes (so `setup` really runs
# `adopt`), `run -d` records a container, and `exec … selfcheck` fails for "broken" ones.
#   vols/<volume>       a volume that exists
#   ids                 every image id on the "server"
#   backup-fails        present: the database snapshot fails
#   no-backup-script    present: the image has no scripts/backup-now.mjs (older than 2.0.0)
#   hold-candidate      present: a *-candidate container does not answer its health check yet
#   proxy-fails         present: a proxy container does not listen on 443 (ports taken)
#   registry-denied     registries (one a line, e.g. ghcr.io) that refuse a pull unless the CLI's
#                       DOCKER_CONFIG/config.json has a login for it (one without "expired")
#   setup-auth-mount    the host folder the set-up container has at /run/buh/registry-auth
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
image_env() {
  if [ -f "$D/image-env" ]; then cat "$D/image-env"; else printf 'PATH=/usr/local/bin:/usr/bin:/bin\nNODE_ENV=production\nPORT=3000\nHOSTNAME=0.0.0.0\nDATA_DIR=/data\n'; fi
}
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
    if [ -z "$service" ]; then
      # docker ps -q / -aq: every (running) container, by name
      for d in "$D"/c/*; do
        [ -f "$d/image" ] || continue
        if [ "$all" = 1 ] || [ "$(cat "$d/status")" = running ]; then basename "$d"; fi
      done
      exit 0
    fi
    c=${service#app-}
    [ -f "$D/c/$c/image" ] || exit 0
    if [ "$all" = 1 ] || [ "$(cat "$D/c/$c/status")" = running ]; then echo "cid-$c"; fi
    ;;
  inspect)
    fmt=$2
    # The set-up container's own mount of the registry login folder (its host path).
    case $fmt in *registry-auth*) cat "$D/setup-auth-mount" 2> /dev/null; exit 0 ;; esac
    c=$(colour_of "$3")
    [ -f "$D/c/$c/image" ] || exit 1
    st=$(cat "$D/c/$c/status")
    h=$(cat "$D/c/$c/health" 2> /dev/null || health_for "$(cat "$D/c/$c/image")")
    [ "$h" = crash ] && h=unhealthy
    case $fmt in
      '{{.Image}}') cat "$D/c/$c/image" ;;
      '{{.RestartCount}}') echo 0 ;;
      '{{.State.Status}}') echo "$st" ;;
      '{{.State.Status}} {{.RestartCount}}') echo "$st 0" ;;
      '{{.Id}}')
        # Each container its own id (a hand-made one gets it on first look).
        [ -f "$D/c/$c/serial" ] || date +%s%N > "$D/c/$c/serial"
        echo "id-$c-$(cat "$D/c/$c/serial")"
        ;;
      *RestartCount*) echo "$st 0 $h" ;;
      *Health*) echo "$st $h" ;;
      '{{len .Config.Env}}') cat "$D/c/$c/envcount" 2> /dev/null || grep -c '' < "$D/c/$c/env" 2> /dev/null || image_env | grep -c '' ;;
      # println per entry, then one more line break from the CLI, as docker and podman print it
      *Config.Env*) { cat "$D/c/$c/env" 2> /dev/null || image_env; } && echo ;;
      *PortBindings*)
        {
          if [ -f "$D/c/$c/bindings" ]; then cat "$D/c/$c/bindings"
          elif [ -s "$D/c/$c/port" ]; then echo "3000/tcp||$(cat "$D/c/$c/port")"; fi
        } | case $fmt in
          # without the container port ({{$p}}): HOSTIP|HOSTPORT
          *'{{'\$'p}}'*) cat ;;
          *) cut -d'|' -f2- ;;
        esac
        ;;
      *.Type*)
        if [ -f "$D/c/$c/mounts" ]; then cat "$D/c/$c/mounts"
        elif [ -s "$D/c/$c/data" ]; then echo "volume|$(cat "$D/c/$c/data")||/data"; fi
        ;;
      *'.Name}}|'*)
        if [ -f "$D/c/$c/mounts" ]; then echo "/$c|$(cut -d'|' -f2 "$D/c/$c/mounts" | tr '\n' ';')"
        else echo "/$c|$(cat "$D/c/$c/data" 2> /dev/null);"; fi
        ;;
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
          *Config.Env*) image_env && echo ;;
          *image.version*) cat "$D/versions/$id" 2> /dev/null || echo '<no value>' ;;
          *RepoDigests*) cat "$D/digests/${id#sha256:}" 2> /dev/null; echo ;;
          *) echo '<no value>' ;;
        esac
        ;;
      prune) ev "prune" ;;
      ls) cat "$D"/tags/* 2> /dev/null | sort -u ;;
    esac
    ;;
  volume)
    # docker volume inspect NAME | docker volume create NAME
    case $1 in
      inspect) [ -f "$D/vols/$2" ] ;;
      create)
        touch "$D/vols/$2"
        ev "volume create $2"
        echo "$2"
        ;;
      *) exit 1 ;;
    esac
    ;;
  version) echo "Server: fake 4.9.3" ;;
  info)
    if [ -f "$D/rootful" ]; then echo '["name=seccomp"]'; else echo '["name=rootless","name=seccomp"]'; fi
    ;;
  pull)
    ref=$2
    # A login the CLI sends (DOCKER_CONFIG/config.json naming the registry, not "expired") is accepted.
    if [ -f "$D/registry-denied" ] && grep -qx "${ref%%/*}" "$D/registry-denied" &&
      ! { grep -qF "\"${ref%%/*}\"" "${DOCKER_CONFIG:-/nonexistent}/config.json" 2> /dev/null &&
        ! grep -q expired "${DOCKER_CONFIG:-/nonexistent}/config.json"; }; then
      ev "pull-denied $ref"
      echo "Error response from daemon: initializing source docker://$ref: reading manifest ${ref##*:} in ${ref%:*}: unauthorized: authentication required" >&2
      exit 1
    fi
    [ -f "$D/registry/$(key "$ref")" ] || { echo "Error response from daemon: $ref: connection refused" >&2; exit 1; }
    cp "$D/registry/$(key "$ref")" "$D/tags/$(key "$ref")"
    # The digest it came under (registry-digest/<ref>, or the ref itself when pulled by digest).
    pid=$(cat "$D/registry/$(key "$ref")")
    case $ref in
      *@sha256:*) dref=$ref ;;
      *) dref=''; [ -f "$D/registry-digest/$(key "$ref")" ] && dref="${ref%:*}@$(cat "$D/registry-digest/$(key "$ref")")" ;;
    esac
    if [ -n "$dref" ]; then
      mkdir -p "$D/digests"
      grep -qxF "$dref" "$D/digests/${pid#sha256:}" 2> /dev/null || printf '%s\n' "$dref" >> "$D/digests/${pid#sha256:}"
      printf '%s\n' "$pid" > "$D/tags/$(key "$dref")"
    fi
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
      *updater.sh\ selfcheck)
        case $(cat "$D/c/$c/image") in *broken*) exit 1 ;; *) exit 0 ;; esac
        ;;
      'nc -z 127.0.0.1 443')
        # The proxy listens, unless its image is broken or the ports are taken (proxy-fails).
        [ ! -f "$D/proxy-fails" ] || exit 1
        case $(cat "$D/c/$c/image") in *broken*) exit 1 ;; *) exit 0 ;; esac
        ;;
      'test -f scripts/backup-now.mjs') [ ! -f "$D/no-backup-script" ] ;;
      'node scripts/backup-now.mjs')
        [ -f "$D/backup-fails" ] && { echo "disk full"; exit 1; }
        ev "backup $who"
        echo /data/backups/pre-update-20261015-000000.db
        ;;
      *api/health*)
        # hold-candidate: a trial container does not answer yet (a slow start).
        case $c in *-candidate) [ -f "$D/hold-candidate" ] && exit 1 ;; esac
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
  run | create)
    # docker run -d --name N (create: the same, not started) [--label k=v] [--restart p -p HOST:3000] -v … -e … … IMAGE
    args="$*"
    name='' port='' data='' spec='' image='' envfile='' pairs='' binds='' mounts=''
    remove=0 entrypoint=''
    nl='
'
    while [ $# -gt 0 ] && [ -z "$image" ]; do
      case $1 in
        --read-only) ;;
        -d) ;;
        --rm) remove=1 ;;
        --entrypoint) entrypoint=$2 && shift ;;
        --user | --stop-timeout) shift ;;
        --name) name=$2 && shift ;;
        --label) case $2 in buh.updater.spec=*) spec=${2#*=} ;; esac && shift ;;
        --restart=*) ;;
        -p)
          hp=${2%:3000}
          [ -n "$port" ] || port=${hp##*:}
          case $hp in *:*) binds="${binds}3000/tcp|${hp%:*}|${hp##*:}$nl" ;; *) binds="${binds}3000/tcp||$hp$nl" ;; esac
          shift
          ;;
        -v)
          case $2 in *:/data) data=${2%%:*} ;; esac
          v=${2%:ro}
          mounts="${mounts}volume|${v%%:*}||${v#*:}$nl"
          shift
          ;;
        --env-file) envfile=$2 && shift ;;
        -e) pairs="$pairs$2$nl" && shift ;;
        --restart | --tmpfs | --cap-drop | --cap-add | --network | --security-opt | --pids-limit) shift ;;
        -*) echo "fake docker: unknown run flag $1" >&2 && exit 125 ;;
        *) image=$1 ;;
      esac
      shift
    done
    id=$(resolve "$image") || { echo "Unable to find image '$image'"; exit 125; }
    # What is left: the command for the image.
    case $id in
      *upd*)
        if [ -n "$entrypoint" ]; then
          ev "prep $*"
          exit 0
        fi
        if [ "$remove" = 1 ]; then
          # Run the updater as that container would: its volumes, its environment.
          ev "updater $*"
          vol_of() { printf '%s' "$mounts" | while IFS='|' read -r _ vname _ vdest; do [ "$vdest" = "$1" ] && printf '%s' "$vname"; done; }
          st=$D/volumes/$(vol_of /state)
          ct=$D/volumes/$(vol_of /control)
          pu=$D/volumes/$(vol_of /public)
          mkdir -p "$st" "$ct" "$pu"
          cmdline=$*
          set --
          while IFS= read -r pair; do [ -z "$pair" ] || set -- "$@" "$pair"; done << EOF
$pairs
EOF
          exec env STATE_DIR="$st" ALERT_DIR="$st/alerts" CONTROL_DIR="$ct" PUBLIC_DIR="$pu" UPDATER_CONTAINER= "$@" \
            sh "$FAKE_UPDATER_SH" "$cmdline"
        fi
        ;;
    esac
    [ -e "$D/c/$name" ] && { echo "the container name \"$name\" is already in use"; exit 125; }
    mkdir -p "$D/c/$name"
    printf '%s\n' "$id" > "$D/c/$name/image"
    printf '%s\n' "$args" > "$D/c/$name/args"
    printf '%s\n' "$data" > "$D/c/$name/data"
    printf '%s\n' "$spec" > "$D/c/$name/spec"
    printf '%s\n' "$port" > "$D/c/$name/port"
    printf '%s' "$binds" > "$D/c/$name/bindings"
    printf '%s' "$mounts" > "$D/c/$name/mounts"
    # The engine's environment: the image's, then the env file's, then -e (and a HOSTNAME, as Podman adds).
    {
      image_env | grep -v '^HOSTNAME='
      echo "HOSTNAME=$name"
      [ -z "$envfile" ] || cat "$envfile"
      printf '%s' "$pairs"
    } > "$D/c/$name/env"
    [ -z "$envfile" ] || cp "$envfile" "$D/c/$name/envfile"
    date +%s%N > "$D/c/$name/serial"
    printf '%s' "$*" > "$D/c/$name/cmd"
    [ -z "$data" ] || touch "$D/vols/$data"
    if [ "$cmd" = create ]; then
      echo created > "$D/c/$name/status"
      ev "create $name $id"
      exit 0
    fi
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
  kill)
    [ -f "$D/c/$1/image" ] || exit 1
    echo exited > "$D/c/$1/status"
    ev "kill $1"
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
