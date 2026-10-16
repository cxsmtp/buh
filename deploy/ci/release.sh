#!/usr/bin/env bash
# The release record (.github/workflows/container.yml, release job, main only): the git tag
# v<VERSION> on this commit and a GitHub Release (as private as the repository) listing the three
# images' digests and the version's CHANGELOG.md entry. A release that exists is left as it is.
#
#   VERSION=2.4.0 SHOP_DIGEST=sha256:… UPDATER_DIGEST=sha256:… PROXY_DIGEST=sha256:… deploy/ci/release.sh
#
# DRY_RUN=1 prints the notes instead (tests). Needs GH_TOKEN (contents: write) and GH_REPO.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${VERSION:?}" "${SHOP_DIGEST:?}" "${UPDATER_DIGEST:?}" "${PROXY_DIGEST:?}"
OWNER=${OWNER:-cxsmtp}
[[ $VERSION =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "not a version: $VERSION" >&2; exit 2; }
for d in "$SHOP_DIGEST" "$UPDATER_DIGEST" "$PROXY_DIGEST"; do
  [[ $d =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "not a digest: $d" >&2; exit 2; }
done
IFS=. read -r major minor patch <<< "$VERSION"
label=$(printf 'BUH-%02d.%02d.%02d' "$major" "$minor" "$patch")

notes() {
  echo "Images (a version is published once: these digests never change; the updater refuses $VERSION under any other):"
  echo
  echo '```'
  echo "ghcr.io/$OWNER/buh:$VERSION@$SHOP_DIGEST"
  echo "ghcr.io/$OWNER/buh-updater:$VERSION@$UPDATER_DIGEST"
  echo "ghcr.io/$OWNER/buh-proxy:$VERSION@$PROXY_DIGEST"
  echo '```'
  echo
  # The entry: its heading line up to the next release's heading.
  awk -v head="## $label " 'index($0, head) == 1 { on = 1 } on && /^## BUH-/ && index($0, head) != 1 { exit } on { print }' CHANGELOG.md
}

if [ "${DRY_RUN:-0}" = 1 ]; then
  notes
  exit 0
fi
if gh release view "v$VERSION" > /dev/null 2>&1; then
  echo "release v$VERSION exists; left as it is"
  exit 0
fi
notes > "${RUNNER_TEMP:-/tmp}/release-notes.md"
gh release create "v$VERSION" --target "${GITHUB_SHA:?}" --title "$label" --notes-file "${RUNNER_TEMP:-/tmp}/release-notes.md"
