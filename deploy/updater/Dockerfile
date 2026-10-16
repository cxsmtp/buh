# ghcr.io/cxsmtp/buh-updater: the updater (updater.sh) in the docker CLI image it already runs
# on, so a single-container shop (Podman on Windows or a Linux server) needs no code on disk:
#
#   podman run --rm --security-opt label=disable -v <socket>:/var/run/docker.sock -e SOCK=<socket> \
#     ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
#
# Built from the repository root: docker build -f deploy/updater/Dockerfile .
# Published by .github/workflows/container.yml next to the shop image (main only).
# docker:28.5.2-cli, pinned by digest (a moved tag cannot change what is built; Dependabot proposes updates).
FROM docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d

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

ENTRYPOINT ["/bin/sh", "/updater/updater.sh"]
CMD ["daemon"]
