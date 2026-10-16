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
FROM caddy:2.8.4-alpine

# Not root: the caddy binary carries the one capability it needs (binding 80 and 443),
# which the container must grant (--cap-add NET_BIND_SERVICE).
RUN adduser -D -H -u 1000 -s /sbin/nologin buhproxy \
 && mkdir -p /data/caddy /config/caddy \
 && chown -R buhproxy:buhproxy /data /config

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
