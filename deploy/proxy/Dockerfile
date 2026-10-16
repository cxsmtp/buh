# ghcr.io/cxsmtp/buh-proxy: Caddy with the shop's HTTPS site, for one shop container on a
# Podman server (no Compose, no code on the server):
#
#   podman run -d --name beautifuluaehome-proxy --network host --restart=always \
#     --read-only --tmpfs /tmp --cap-drop ALL --cap-add NET_BIND_SERVICE \
#     --security-opt no-new-privileges:true -v beautifuluaehome-proxy-data:/data \
#     -v beautifuluaehome-proxy-config:/config -e DOMAIN=shop.example.com ghcr.io/cxsmtp/buh-proxy
#
# Settings: see deploy/proxy/Caddyfile (DOMAIN, ACME_EMAIL, UPSTREAM, WWW_REDIRECT).
#
# (`buh-updater setup … --proxy DOMAIN` starts it exactly so and keeps it up to date.)
# Built from the repository root: docker build -f deploy/proxy/Dockerfile .
# caddy:2.8.4-alpine, pinned by digest (a moved tag cannot change what is built; Dependabot proposes updates).
FROM caddy:2.8.4-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17

# Not root: the caddy binary carries the one capability it needs (binding 80 and 443),
# which the container must grant (--cap-add NET_BIND_SERVICE).
# The user is written out rather than made with adduser, which stamps today's date into
# /etc/shadow: the image must come out byte for byte the same when nothing in it changed,
# so that a release does not restart the proxy (see container.yml).
RUN printf 'buhproxy:x:1000:1000::/nonexistent:/sbin/nologin\n' >> /etc/passwd \
 && printf 'buhproxy:x:1000:\n' >> /etc/group \
 && mkdir -p /data/caddy /config/caddy \
 && chown -R 1000:1000 /data /config

COPY deploy/shop-snippets.caddy /etc/caddy/shop-snippets.caddy
COPY deploy/proxy/*.caddy deploy/proxy/Caddyfile /etc/caddy/
RUN chmod 0444 /etc/caddy/*

USER buhproxy
LABEL buh.role=proxy
VOLUME ["/data", "/config"]
EXPOSE 80 443 443/udp
# Caddy itself, not a shell: with no-new-privileges, the capability to bind 80 and 443
# reaches the binary only when the container starts it directly.
ENTRYPOINT ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
