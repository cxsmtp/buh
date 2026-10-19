#!/usr/bin/env bash
# CI (.github/workflows/zero-downtime.yml, checks): deploy/ci/publish-version.sh against a local
# registry (registry:2): a version is tagged once; the same digest again changes nothing; another
# digest under that version is refused and moves no tag (not even latest); a re-run of the same
# commit passes; a new version is tagged.
set -euo pipefail
cd "$(dirname "$0")/../.."
REGISTRY_IMAGE=${REGISTRY_IMAGE:-registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373}
BASE=${BASE:-caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f}
PORT=5099
REPO=127.0.0.1:$PORT/cxsmtp/publish-test
fail() {
  echo "FAILED: $*" >&2
  exit 1
}
cleanup() { docker rm -f buh-publish-registry > /dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT
docker run -d --name buh-publish-registry -p "127.0.0.1:$PORT:5000" "$REGISTRY_IMAGE" > /dev/null
for _ in $(seq 1 30); do curl --noproxy '*' -sf "http://127.0.0.1:$PORT/v2/" > /dev/null && break; sleep 1; done

# Two builds with different contents, pushed by digest (no tag), as the workflow does.
push_variant() { # push_variant NAME: prints its digest
  local c
  c=$(docker create "$BASE")
  docker commit --change "LABEL ci.variant=$1" "$c" "$REPO:tmp-$1" > /dev/null
  docker rm "$c" > /dev/null
  docker push -q "$REPO:tmp-$1" > /dev/null
  docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$REPO:tmp-$1"
}
A=$(push_variant a)
B=$(push_variant b)
[ "$A" != "$B" ] || fail "the two builds have the same digest"
tag_digest() { docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$REPO:$1"; }

echo "1. a new version is tagged, with its commit tag and latest"
[ "$(deploy/ci/publish-version.sh "$REPO" 1.0.0 "$A" sha-c1 latest)" = "$A" ] || fail "1.0.0"
[ "$(tag_digest 1.0.0)" = "$A" ] && [ "$(tag_digest latest)" = "$A" ] && [ "$(tag_digest sha-c1)" = "$A" ] || fail "tags after 1.0.0"

echo "2. the same digest again: nothing changes"
deploy/ci/publish-version.sh "$REPO" 1.0.0 "$A" sha-c1 latest > /dev/null || fail "same digest refused"

echo "3. other contents under 1.0.0 (a second commit without a version bump): refused, no tag moves"
if out=$(deploy/ci/publish-version.sh "$REPO" 1.0.0 "$B" sha-c2 latest 2>&1); then fail "another digest under 1.0.0 was accepted"; fi
grep -q "1.0.0 already exists with digest $A; this build is $B" <<< "$out" || fail "unclear message: $out"
[ "$(tag_digest 1.0.0)" = "$A" ] || fail "1.0.0 moved"
[ "$(tag_digest latest)" = "$A" ] || fail "latest moved although the publish was refused"
if docker buildx imagetools inspect "$REPO:sha-c2" > /dev/null 2>&1; then fail "the refused commit got a tag"; fi

echo "4. a re-run of the commit that published 1.0.0 (a new build, other digest): passes, changes nothing"
[ "$(deploy/ci/publish-version.sh "$REPO" 1.0.0 "$B" sha-c1 latest 2> /dev/null)" = "$A" ] || fail "re-run of the same commit"
[ "$(tag_digest 1.0.0)" = "$A" ] && [ "$(tag_digest latest)" = "$A" ] || fail "tags moved on the re-run"

echo "5. the next version is tagged and latest moves"
deploy/ci/publish-version.sh "$REPO" 1.0.1 "$B" sha-c2 latest > /dev/null || fail "1.0.1"
[ "$(tag_digest 1.0.1)" = "$B" ] && [ "$(tag_digest latest)" = "$B" ] && [ "$(tag_digest 1.0.0)" = "$A" ] || fail "tags after 1.0.1"

echo "6. bad input is refused"
if deploy/ci/publish-version.sh "$REPO" 1.0 "$B" sha-c3 2> /dev/null; then fail "a malformed version was accepted"; fi
if deploy/ci/publish-version.sh "$REPO" 1.0.2 "latest" sha-c3 2> /dev/null; then fail "a malformed digest was accepted"; fi
echo "publish-version test passed"
