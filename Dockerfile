# Base image with Node.js LTS on Alpine for minimal footprint
# node:24.22.0-alpine3.24 (Node 24 LTS; Node 20 is past its end of life), pinned by digest;
# Dependabot proposes the newer digest (security fixes) as a pull request.
FROM node:26.12.0-alpine3.24@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS base

# Step 1: Install dependencies
FROM base AS deps
# Build tools only for the native SQLite driver, if no prebuilt binary matches.
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Step 2: Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set production environment for build
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Step 3: Production runner
FROM base AS runner
WORKDIR /app

# Security patches for the runtime layer; tini reaps zombies and forwards
# SIGTERM so in-flight checkouts finish before the container stops.
# The shop runs `node server.js` and `node scripts/…` only: the package managers that come with
# the base image (npm, npx, corepack, yarn, with their own bundled modules) are removed, so
# nothing in the running image installs or fetches code.
RUN apk upgrade --no-cache && apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /root/.npm

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Admin account, session key and audit log live here: mount a volume.
ENV DATA_DIR=/data

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /data && chown nextjs:nodejs /data && chmod 700 /data

# Copy public assets & standalone build output (read-only for the app user)
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Restore tool (node scripts/restore-backup.mjs) inside the container.
COPY --from=builder /app/scripts/restore-backup.mjs ./scripts/restore-backup.mjs
# Its --from-drive mode (a copy from Google Drive, for rebuilding on a new server from the image alone).
COPY --from=builder /app/scripts/restore-from-drive.mjs ./scripts/restore-from-drive.mjs
# Database snapshot the updater takes before switching versions (node scripts/backup-now.mjs).
COPY --from=builder /app/scripts/backup-now.mjs ./scripts/backup-now.mjs
# The Admin Hub's private link: make a new one when it is lost (node scripts/admin-link.mjs --new).
COPY --from=builder /app/scripts/admin-link.mjs ./scripts/admin-link.mjs
# The updater script, for scripts/podman-autoupdate.bat to copy into the updater's volume
# (single-container mode). The shop never runs it: it has no container engine access.
COPY --from=builder /app/deploy/updater ./updater

USER nextjs

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
