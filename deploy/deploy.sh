#!/usr/bin/env bash
# Beautiful UAE Home - Automated Deployment Script for Hostinger VPS
# Run this on your server whenever you pull updates: bash deploy/deploy.sh

set -e

echo "=== 🚀 Starting BUHome UAE Deployment on Hostinger ==="

# 1. Pull latest code
echo "📦 Pulling latest changes from git..."
git pull origin main

# 2. Install production dependencies
echo "📥 Installing dependencies..."
npm ci --prefer-offline --no-audit

# 3. Build standalone Next.js application
echo "🔨 Building optimized Next.js standalone bundle..."
npm run build

# 4. Copy static assets to standalone directory (required for standalone output)
echo "📁 Syncing static assets..."
cp -rn .next/static .next/standalone/.next/ || true
cp -rn public .next/standalone/ || true

# 5. Data folder for the admin account, session key and audit log (owner-only)
sudo mkdir -p /var/lib/buhome && sudo chown "$(id -u):$(id -g)" /var/lib/buhome && chmod 700 /var/lib/buhome

# 6. Reload PM2
echo "🔄 Reloading PM2 processes..."
pm2 reload buhome-app --update-env || pm2 start ecosystem.config.cjs

echo "✅ BUHome UAE is now live and serving traffic!"
echo "ℹ️  First deploy? The one-time admin password is in: pm2 logs buhome-app --lines 50"
pm2 status
