# ghcr.io/cxsmtp/buh-updater: the updater (updater.sh) with the docker CLI it talks to the
# engine with, so a single-container shop (Podman on Windows or a Linux server) needs no code on disk:
#
#   podman run --rm --security-opt label=disable -v <socket>:/var/run/docker.sock -e SOCK=<socket> \
#     ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
#
# Built from the repository root: docker build -f deploy/updater/Dockerfile .
# Published by .github/workflows/container.yml next to the shop image (main only).
# Bases pinned by digest (a moved tag cannot change what is built; Dependabot proposes updates):
# the docker CLI binary from docker:29.9.1-cli, on plain alpine:3.24. The updater only talks to
# the engine's API socket, so the CLI image's Compose and Buildx plugins, its source-control
# client and its SSH client stay out of this image (less to patch, less to attack).
FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS cli

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY deploy/updater/updater.sh /updater/updater.sh
COPY deploy/updater/bin/ /updater/bin/
RUN chmod 0555 /updater/updater.sh /updater/bin/* && chmod 0555 /updater /updater/bin

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
