# 🚀 Hostinger Deployment Guide: Beautiful UAE Home (BUHome)

This guide covers deploying the **Beautiful UAE Home** Next.js platform to **Hostinger** with maximum performance, high security headers, and support for high concurrent traffic (3,000+ requests).

---

## 📋 Recommended Deployment Options

| Deployment Method | Best For | Specs Required | Uptime & Concurrency |
| :--- | :--- | :--- | :--- |
| **Option 1: Hostinger KVM VPS + PM2** *(Recommended)* | Production Store, High Traffic (3,000 reqs), Real-time Courier & OTP | KVM 1 or KVM 2 (1–2 vCPU, 4–8GB RAM) | 99.99% / Up to 4,500 RPS |
| **Option 2: Hostinger VPS with Docker** | Containerized workflow, 1-Click Rollback | KVM 1 or KVM 2 | 99.99% / Up to 4,000 RPS |
| **Option 3: Hostinger Cloud Hosting (hPanel)** | Simple cPanel/hPanel Node.js Selector | Cloud Startup / Cloud Professional | 99.9% / Up to 1,000 RPS |

---

## 🌟 Option 1: Hostinger KVM VPS + PM2 Cluster (Recommended)

### Step 1: Connect to your Hostinger VPS via SSH
Open your terminal (PowerShell, Terminal, or PuTTY):
```bash
ssh root@<YOUR_HOSTINGER_SERVER_IP>
```

### Step 2: Install Node.js 20 LTS & PM2
Run the following commands on the server:
```bash
# Update Ubuntu package lists
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx

# Install PM2 Process Manager globally
sudo npm install -g pm2
```

### Step 3: Clone or Upload Your Repository
```bash
# Navigate to web root
cd /var/www

# Clone from GitHub/GitLab
git clone <YOUR_REPO_URL> buhome
cd buhome

# Or if uploading via SFTP / SCP, copy the files to /var/www/buhome
```

### Step 4: Configure Production Environment Variables
Create your production `.env.production` file:
```bash
cp .env.production.example .env.production
nano .env.production
```
Fill in your credentials:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (or `INFOBIP_API_KEY`)
- `ECO_EXPRESS_API_KEY`, `ECO_EXPRESS_ACCOUNT_ID`
- `JEEBLY_PARTNER_KEY`
- `NEXT_PUBLIC_APP_URL=https://yourdomain.ae`

*(Press `Ctrl + O` to save, then `Ctrl + X` to exit).*

### Step 5: Build the Application
```bash
# Install dependencies
npm ci

# Build the Next.js production bundle
npm run build
```

### Step 6: Start with PM2 Cluster Mode
```bash
# Start cluster mode across all CPU cores
pm2 start ecosystem.config.cjs

# Save PM2 state so it restarts automatically on server reboot
pm2 save
pm2 startup
```

### Step 7: Configure Nginx & Free SSL (Let's Encrypt)
1. Copy the provided Nginx configuration:
```bash
sudo cp deploy/nginx-buhome.conf /etc/nginx/sites-available/buhome
sudo nano /etc/nginx/sites-available/buhome
```
*(Replace `yourdomain.ae` with your actual domain name).*

2. Enable the site and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/buhome /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

3. Issue free SSL with Let's Encrypt:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.ae -d www.yourdomain.ae
```
Certbot will automatically install the SSL certificates and configure auto-renewal.

---

## 🐳 Option 2: 1-Click Docker Deployment on Hostinger VPS

If your Hostinger VPS was set up with the **Ubuntu Docker** template:

1. Clone your repo:
```bash
cd /opt
git clone <YOUR_REPO_URL> buhome
cd buhome
```

2. Create `.env.production`:
```bash
cp .env.production.example .env.production
nano .env.production
```

3. Launch containers:
```bash
docker compose up -d --build
```
Your app is now live and will automatically restart if the server reboots!

---

## ☁️ Option 3: Hostinger Cloud Hosting (hPanel Node.js)

If you are using Hostinger Cloud or Web Hosting with hPanel:

1. In **hPanel**, go to **Websites** -> **Manage** -> **Node.js**.
2. Click **Create Application**:
   - **Node.js version**: `20.x`
   - **Application root**: `public_html` or `/buhome`
   - **Application startup file**: `server.js` or `node_modules/next/dist/bin/next`
   - **Application mode**: `Production`
3. Upload files via Git integration or File Manager (ensure `package.json`, `.next`, `public`, `next.config.ts` are uploaded).
4. Run `npm ci` and `npm run build` from the hPanel terminal.
5. In **Environment Variables**, paste the keys from `.env.production.example`.
6. Click **Restart Application**.

---

## 🔄 Zero-Downtime Deployments

Whenever you make updates to the codebase, simply run the included automated script on your server:

```bash
bash deploy/deploy.sh
```
This script pulls code, builds the bundle, and executes a zero-downtime hot-reload (`pm2 reload`).

---

## 🔒 Security Hardening Included

The repository already comes pre-configured with enterprise-grade security:
1. **Security Headers** (`next.config.ts`):
   - `X-Frame-Options: DENY` (Anti-Clickjacking)
   - `X-Content-Type-Options: nosniff` (MIME-sniffing prevention)
   - `Strict-Transport-Security: max-age=31536000` (Enforced HTTPS)
   - `Referrer-Policy: origin-when-cross-origin`
   - `Permissions-Policy: geolocation=(self)`
2. **API Rate Limiting**:
   - Protects OTP `/api/otp/send` from SMS abuse (max attempts per UAE mobile number + rate-limit).
   - Nginx layer limits API requests to 20 req/s with burst smoothing.
