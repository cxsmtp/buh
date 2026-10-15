# Hostinger Deployment Guide: Beautiful UAE Home

**Recommended model: one Hostinger KVM VPS running Docker Compose.** Two containers run on it:

- the shop;
- Caddy, which gets and renews the free HTTPS certificate.

Everything the shop stores lives in one Docker volume and is backed up every 12 hours, by email.

| Option | Use it? | Why |
| --- | --- | --- |
| **KVM VPS + Docker Compose** (this guide) | ✅ Recommended | One command to start or update. HTTPS is automatic. The database, photos and receipts persist in a volume. Backups run on their own. Rollback means starting the previous version. The containers run read-only, as non-root, with no extra privileges. |
| KVM VPS + PM2 + nginx | Possible | It works (see the end of this guide), but you look after Node, nginx, certbot and the data folder yourself. |
| Shared / Cloud hosting (hPanel Node.js) | ❌ Not for this shop | The shop needs a persistent data folder for its database, a native SQLite module, and a process that keeps running for the 12-hourly backups. hPanel Node.js hosting is not built for that. |

**Size:** KVM 2 (2 vCPU, 8 GB) is comfortable. KVM 1 is enough to start. Choose the data centre region closest to the UAE that Hostinger offers.

**Run one copy of the shop only.** Phone codes and limits are kept in that one process's memory, and the database is a single file. Don't put a second copy behind a load balancer.

---

## 1. One-time setup (about 20 minutes)

1. **Create the VPS.**
   - In hPanel, go to **VPS → choose the Ubuntu 24.04 with Docker template**.
   - Note the server's IP address.
   - Turn on **automatic weekly backups (snapshots)** in hPanel as an extra layer.
2. **Point your domain at it.** At your DNS provider, add an `A` record for `yourdomain.ae` and one for `www`, both pointing to the VPS IP.
3. **Connect and lock down the firewall:**
   ```bash
   ssh root@<VPS_IP>
   ```
   ```bash
   ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
   ```
4. **Get the code:**
   ```bash
   git clone https://github.com/cxsmtp/buh.git /opt/buhome && cd /opt/buhome
   ```
5. **Settings:**
   ```bash
   cp .env.production.example .env.production && nano .env.production
   ```
   - Fill in `DOMAIN`, `ACME_EMAIL`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPPORT_EMAIL`.
   - **Fill in the backup email (`SMTP_*`, `BACKUP_EMAIL`).**
   - Set a `BACKUP_PASSPHRASE` of at least 12 characters, and store it in your password manager. Without it, customer data is emailed unencrypted.
6. **Start** (pulls the ready-made image `ghcr.io/cxsmtp/buh:latest`):
   ```bash
   docker compose pull app && docker compose up -d
   ```
   Then <https://yourdomain.ae> shows the shop with a valid certificate. To build the image on the server instead, use `docker compose up -d --build` (a few minutes).
7. **First admin sign-in.** The one-time password is in the log:
   ```bash
   docker compose logs app | grep -A3 "first admin"
   ```
   Open the shop and click **Admin Hub**. Sign in with that email and password, then choose your own password.

## 2. Go-live checklist (in the Admin Hub)

- [ ] **📱 SMS & Real OTP:** enter your Twilio or Infobip keys, **Send test** to your own mobile, then **Save**.
  - Checkout needs a working SMS gateway: customers cannot order without verifying their number.
  - At start-up, the log warns if none is configured.
- [ ] **🎨 Logo & Marquee → Bank transfer details:** enter the bank name, account name and real IBAN, and check every digit. Bank transfer is hidden at checkout until they are saved.
- [ ] **Jeebly & Eco Couriers:**
  - enter the keys;
  - press **Test connection**;
  - switch to **live mode** only when you are ready to book real pickups.
- [ ] **Inventory Stock:** set real prices and stock, and hide any sample products you don't sell.
- [ ] **Backups:** press **Back up now** at the top of the Admin Hub.
  - Check that the email arrives (with `BACKUP_PASSPHRASE`, one encrypted `.tar.gz.enc` file; without it, the CSV files and the `.tar.gz`).
  - The status line should be green.
- [ ] **Restore drill:** restore that backup on your computer (section 4), so you know it works before you need it.
- [ ] **A real test order:** place it from your phone, then confirm, book and cancel it in the Admin Hub.
- [ ] **Uptime monitor:** use a free service (e.g. UptimeRobot) on `https://yourdomain.ae/api/health`.

## 3. Backups (automatic, every 12 hours)

The shop backs itself up every 12 hours, and straight after a restart if one is due. It emails the backup to `BACKUP_EMAIL` and keeps the newest 14 on the server. Each backup contains:

- **The full database** (`shop.db`): every order, product, setting and booking. Courier and SMS keys are blanked: re-enter them after a restore.
- **Flat files you can open in Excel:** `orders.csv`, `order_items.csv`, `customers.csv`, `products.csv`.
- **Bank-transfer receipts and product photos.**
- **The audit log.**
- **A checksum manifest:** a damaged file is detected.

**Encryption:** with `BACKUP_PASSPHRASE` set, the email carries one AES-256 encrypted file instead of plain customer data. That is recommended, because email is not a safe place for customers' addresses and phone numbers.

**If something is wrong**, the status line at the top of the Admin Hub turns amber (taken but not emailed) or red (failed or overdue), and a failure is also emailed. **Back up now** runs one immediately.

Before an update, press **Back up now**.

Copy the server's backups to your computer:

```bash
docker compose cp app:/data/backups ./backups
```

## 4. Restore

On the server (this replaces the live data; the current data is kept aside in `replaced-<time>/`):

1. Stop the shop:
   ```bash
   docker compose stop app
   ```
2. Restore a backup kept on the server (`docker compose run --rm --no-deps app ls /data/backups` lists them):
   ```bash
   docker compose run --rm --no-deps app node scripts/restore-backup.mjs /data/backups/buh-backup-20261014-1200.tar.gz.enc /data --replace
   ```
   For a backup from your email, first make it readable and copy it in:
   ```bash
   chmod 644 buh-backup-….tar.gz.enc && docker compose cp buh-backup-….tar.gz.enc app:/data/backups/
   ```
3. Start it again:
   ```bash
   docker compose start app
   ```

Then sign in with the new one-time password from `docker compose logs app`, and re-enter the courier and SMS keys. Keys and the admin account are deliberately not in backups.

To check a backup on your own computer (Node 20+, in a checkout of this repository after `npm ci`):

```bash
BACKUP_PASSPHRASE='your passphrase' node scripts/restore-backup.mjs buh-backup-….tar.gz.enc ./restored
```

Plain `.tar.gz` backups also open with any archive tool (`tar -xzf`).

## 5. Updates and rollback

1. Press **Back up now**.
2. Update:
   ```bash
   cd /opt/buhome && git pull && docker compose pull app && docker compose up -d
   ```

The shop stops for a few seconds while the new version starts. In-flight requests get up to 20 seconds to finish. The version (`BUH-xx.xx.xx`) shows next to the Admin Hub title.

**Roll back:**

```bash
git checkout <previous version tag or commit> && docker compose up -d --build
```

Or run a previous published image: every version is kept as `ghcr.io/cxsmtp/buh:<version>` (for example `1.1.0`); set it as the `image:` in docker-compose.yml and run `docker compose up -d`.

If a release changed the database, restore the backup taken before the update.

## 6. Logs and health

- Logs:
  ```bash
  docker compose logs -f app
  ```
  Errors are logged with secrets redacted, and phone numbers and emails masked.
- State:
  ```bash
  docker compose ps
  ```
  The app shows `healthy` when `/api/health` answers.
- Audit log: `docker compose exec app ls /data` lists the `audit-YYYY-MM.jsonl` files (one line per sign-in, order change, booking, setting change and backup).

---

## Alternative: PM2 + nginx without Docker

Only if you cannot use Docker.

1. Install Node 20 and the build tools for the SQLite module:
   ```bash
   apt install -y build-essential python3
   ```
2. Clone to `/var/www/buhome` and copy `.env.production.example` to `.env.production`.
3. Create the data folder:
   ```bash
   mkdir -p /var/lib/buhome && chmod 700 /var/lib/buhome
   ```
4. Run `bash deploy/deploy.sh`. It builds and starts one PM2 process, with `DATA_DIR=/var/lib/buhome` and `TRUST_PROXY=1` from `ecosystem.config.cjs`.
5. Put nginx in front using `deploy/nginx-buhome.conf`, and get a certificate with certbot.

Back up `/var/lib/buhome`: the built-in 12-hour email backups run the same way.

---

## Security

What is built in, and what you must do, is in [docs/security.md](docs/security.md). In short:

1. **Admin sign-in is checked on the server.** Passwords are scrypt-hashed, the session cookie is HttpOnly, and sign-in pauses after 5 wrong attempts from one address. The first start prints a one-time password to the log.
2. **Prices, stock and totals are computed on the server** from the catalogue. Every order carries a phone number proven by an SMS code.
3. **Every admin action is checked on the server** and audited. Courier and SMS keys are write-only: they never reach a browser.
4. **Security headers on every page:** a Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, HSTS and a tight `Permissions-Policy`.
5. **Containers** run read-only, as non-root, with every Linux capability dropped. Only Caddy is reachable from outside.
