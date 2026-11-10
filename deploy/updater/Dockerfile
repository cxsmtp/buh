# ghcr.io/cxsmtp/buh-updater: the updater (updater.sh) with the docker CLI it talks to the
# engine with, so a single-container shop (Podman on Windows or a Linux server) needs no code on disk:
#
#   podman run --rm --security-opt label=disable -v <socket>:/var/run/docker.sock -e SOCK=<socket> \
#     ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
#
# Built from the repository root: docker build -f deploy/updater/Dockerfile .
# Published by .github/workflows/container.yml next to the shop image (main only).
# Bases pinned by digest (a moved tag cannot change what is built; Dependabot proposes updates):
# the docker CLI binary from docker:29.9.3-cli, on plain alpine:3.24. The updater only talks to
# the engine's API socket, so the CLI image's Compose and Buildx plugins, its source-control
# client and its SSH client stay out of this image (less to patch, less to attack).
FROM docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d AS cli

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY deploy/updater/updater.sh /updater/updater.sh
COPY deploy/updater/bin/ /updater/bin/
# zlib upgraded past the base image's 1.3.2-r1 (CVE-2026-4738, flagged by the security scan);
# apk's own log is removed so a rebuild comes out the same.
RUN apk upgrade --no-cache zlib && rm -f /var/log/apk.log \
 && chmod 0555 /updater/updater.sh /updater/bin/* && chmod 0555 /updater /updater/bin

# Single-container mode; the compose (blue/green) set-up mounts the script into the plain
# docker CLI image instead and does not use this image.
ENV UPDATER_MODE=single \
    PATH=/updater/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp \
    DOCKER_CONFIG=/state/docker-config

# Not a shop version: publish_status leaves images with this label out of Settings → Versions.
LABEL buh.role=updater

# Healthy while the engine answers through the socket and the script parses (the same check
# a self-update makes of a new updater). Root on purpose: the engine's socket is root's
# (Podman: root:root 0660); the container has no capability but CHOWN and FOWNER (setup).
HEALTHCHECK --interval=5m --timeout=30s --start-period=1m --retries=3 \
  CMD ["/bin/sh", "/updater/updater.sh", "selfcheck"]

ENTRYPOINT ["/bin/sh", "/updater/updater.sh"]
CMD ["daemon"]
