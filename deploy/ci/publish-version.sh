#!/usr/bin/env bash
# A version is published once and never changes (.github/workflows/container.yml, main only).
#
#   deploy/ci/publish-version.sh IMAGE VERSION DIGEST COMMIT-TAG [MOVING-TAG ...]
#
# IMAGE@DIGEST was pushed without a tag. It gets IMAGE:VERSION, IMAGE:COMMIT-TAG (sha-…) and the
# moving tags (latest), unless IMAGE:VERSION already exists under another digest: then nothing is
# tagged and it fails (bump the version in package.json). A re-run for the same commit, whose
# COMMIT-TAG already names the published digest, changes nothing and passes. Prints the digest
# IMAGE:VERSION names, last.
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "usage: $0 IMAGE VERSION DIGEST COMMIT-TAG [MOVING-TAG ...]" >&2
  exit 2
fi
image=$1 version=$2 digest=$3 commit_tag=$4
shift 4
[[ $version =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "not a version: $version" >&2; exit 2; }
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "not a digest: $digest" >&2; exit 2; }

# The digest a tag names now; empty when the tag does not exist. Any other failure stops here.
digest_of() {
  local out
  if out=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$1" 2>&1); then
    printf '%s' "$out"
  elif grep -qiE 'not found|manifest unknown|404' <<< "$out"; then
    printf ''
  else
    echo "could not look up $1: $out" >&2
    return 1
  fi
}

existing=$(digest_of "$image:$version")
if [ -n "$existing" ] && [ "$existing" != "$digest" ]; then
  if [ "$(digest_of "$image:$commit_tag")" = "$existing" ]; then
    echo "$image:$version was already published from this commit ($existing); nothing changed." >&2
    printf '%s\n' "$existing"
    exit 0
  fi
  echo "::error::$image:$version already exists with digest $existing; this build is $digest. A published version never changes: bump the version in package.json (and CHANGELOG.md)." >&2
  exit 1
fi

tags=(-t "$image:$version" -t "$image:$commit_tag")
for t in "$@"; do tags+=(-t "$image:$t"); done
docker buildx imagetools create --prefer-index=false "${tags[@]}" "$image@$digest" >&2
now=$(digest_of "$image:$version")
if [ "$now" != "$digest" ]; then
  echo "::error::$image:$version names $now after tagging, not $digest" >&2
  exit 1
fi
echo "$image:$version -> $digest" >&2
printf '%s\n' "$digest"
