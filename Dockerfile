# Base image with Node.js LTS on Alpine for minimal footprint
# node:20-alpine, pinned by digest; Dependabot proposes the newer digest (security fixes) as a pull request.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base

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
RUN apk upgrade --no-cache && apk add --no-cache tini

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
