# Hostinger Deployment Guide: Beautiful UAE Home

**Recommended model: one Hostinger KVM VPS running Docker Compose.** These containers run on it:

- the shop, as `app-blue` or `app-green`: two identical copies of one definition, of which one runs (both run for about a minute during an update);
- Caddy, which gets and renews the free HTTPS certificate and sends visitors to the copy that is healthy;
- optionally, the **updater**, which installs new versions without downtime, rolls back a version that does not start, and restarts the shop if it stops answering (section 5).

Everything the shop stores lives in one Docker volume and is backed up every 12 hours, by email.

| Option | Use it? | Why |
| --- | --- | --- |
| **KVM VPS + Docker Compose** (this guide) | ✅ Recommended | One command to start. Updates switch between two copies without closing the shop, and a version that fails is rolled back on its own. HTTPS is automatic. The database, photos and receipts persist in a volume. Backups run on their own. The shop containers run read-only, as non-root, with no extra privileges. |
| KVM VPS + PM2 + nginx | Possible | It works (see the end of this guide), but you look after Node, nginx, certbot and the data folder yourself. |
| Shared / Cloud hosting (hPanel Node.js) | ❌ Not for this shop | The shop needs a persistent data folder for its database, a native SQLite module, and a process that keeps running for the 12-hourly backups. hPanel Node.js hosting is not built for that. |

**Size:** KVM 2 (2 vCPU, 8 GB) is comfortable. KVM 1 is enough to start. Choose the data centre region closest to the UAE that Hostinger offers.

**One copy of the shop serves at a time.** Phone codes and limits are kept in that process's memory, and the database is a single file. During an update the new copy starts beside the old one on the same database (safe on one server), Caddy moves visitors over, and the old copy stops. Don't run more copies, and don't put the shop behind another load balancer.

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
   docker compose pull app-blue && docker compose up -d
   ```
   Then <https://yourdomain.ae> shows the shop with a valid certificate. To build the image on the server instead, use `docker compose up -d --build` (a few minutes).
7. **First admin sign-in.** The one-time password is in the log:
   ```bash
   docker compose logs app-blue | grep -A3 "first admin"
   ```
   Open the shop and click **Admin Hub**. Sign in with that email and password, then choose your own password.

## 2. Go-live checklist (in the Admin Hub)

- [ ] **⚙️ Settings → Phone verification:** enter your Twilio or Infobip keys, **Send test** to your own mobile, then **Save**.
  - Or choose **Firebase Phone Auth** (Blaze plan, billed per SMS; see docs/user-guide.md) and test with a checkout on your phone.
  - Checkout needs a working SMS gateway: customers cannot order without verifying their number.
  - At start-up, the log warns if none is configured.
- [ ] **⚙️ Settings → Store & contact:** your WhatsApp number, support email and Instagram account.
- [ ] **⚙️ Settings → Branding & bank → Bank transfer details:** enter the bank name, account name and real IBAN, and check every digit. Bank transfer is hidden at checkout until they are saved.
- [ ] **⚙️ Settings → Couriers:**
  - enter the keys;
  - press **Test connection**;
  - switch to **live mode** only when you are ready to book real pickups.
- [ ] **Inventory Stock:** add your products with their real pieces per size, and **Remove** the sample products.
- [ ] **Instagram / Facebook Shopping (optional):** add `https://yourdomain.ae/feeds/meta.csv` as a scheduled feed in Meta Commerce Manager.
- [ ] **Outbound access:** the server fetches exchange rates (open.er-api.com) daily and festival dates (calendar.google.com) weekly; if they are blocked, built-in festival dates are used and no local currency is shown.
- [ ] **Backups:** press **Back up now** at the top of the Admin Hub.
  - Check that the email arrives (with `BACKUP_PASSPHRASE`, one encrypted `.tar.gz.enc` file; without it, the CSV files and the `.tar.gz`).
  - The status line should be green.
- [ ] **Restore drill:** restore that backup on your computer (section 4), so you know it works before you need it.
- [ ] **A real test order:** place it from your phone, then confirm, book and cancel it in the Admin Hub.
- [ ] **Uptime monitor:** use a free service (e.g. UptimeRobot) on `https://yourdomain.ae/api/health`.
- [ ] **Automatic updates** (recommended): turn on the updater (section 5).

## 3. Backups (automatic, every 12 hours)

The shop backs itself up every 12 hours, and straight after a restart if one is due. It emails the backup to `BACKUP_EMAIL` and keeps the newest 14 on the server. Each backup contains:

- **The full database** (`shop.db`): every order, product, setting and booking. Courier and SMS keys are blanked: re-enter them after a restore.
- **Flat files you can open in Excel:** `orders.csv`, `order_items.csv`, `customers.csv`, `products.csv`.
- **Bank-transfer receipts and product photos.**
- **The audit log.**
- **A checksum manifest:** a damaged file is detected.

**Encryption:** with `BACKUP_PASSPHRASE` set, the email carries one AES-256 encrypted file instead of plain customer data. That is recommended, because email is not a safe place for customers' addresses and phone numbers.

**If something is wrong**, the status line at the top of the Admin Hub turns amber (taken but not emailed) or red (failed or overdue), and a failure is also emailed. **Back up now** runs one immediately.

Before every update, the updater also saves a copy of the database on the server, as `backups/pre-update-<time>.db` (the newest 5 are kept).

Copy the server's backups to your computer (use `app-green` if that is the copy `docker compose ps` shows running):

```bash
docker compose cp app-blue:/data/backups ./backups
```

## 4. Restore

On the server (this replaces the live data; the current data is kept aside in `replaced-<time>/`):

1. Stop the updater first (otherwise it restarts the shop it finds stopped), then the shop:
   ```bash
   docker compose stop updater
   ```
   ```bash
   docker compose stop app-blue app-green
   ```
2. Restore a backup kept on the server (`docker compose run --rm --no-deps app-blue ls /data/backups` lists them):
   ```bash
   docker compose run --rm --no-deps app-blue node scripts/restore-backup.mjs /data/backups/buh-backup-20261014-1200.tar.gz.enc /data --replace
   ```
   For a backup from your email, first make it readable and copy it in:
   ```bash
   chmod 644 buh-backup-….tar.gz.enc && docker compose cp buh-backup-….tar.gz.enc app-blue:/data/backups/
   ```
3. Start it again, then the updater (if you use it):
   ```bash
   docker compose up -d --no-deps app-blue
   ```
   ```bash
   docker compose start updater
   ```

Then sign in with the new one-time password from `docker compose logs app-blue`, and re-enter the courier and SMS keys. Keys and the admin account are deliberately not in backups.

To check a backup on your own computer (Node 20+, in a checkout of this repository after `npm ci`):

```bash
BACKUP_PASSPHRASE='your passphrase' node scripts/restore-backup.mjs buh-backup-….tar.gz.enc ./restored
```

Plain `.tar.gz` backups also open with any archive tool (`tar -xzf`).

## 5. Updates without downtime, and rollback

The shop runs as one of two identical copies, `app-blue` or `app-green`. An update starts the new version as the copy that is not running, beside the one serving customers, and switches over only when the new one is healthy:

1. The database is saved to `backups/pre-update-<time>.db`. If that fails, nothing changes.
2. The new version starts as the idle copy. It must pass its health check and load the home page within 2 minutes.
3. **Healthy:** Caddy sends visitors to it, the old copy finishes the requests it is serving (up to 25 s) and stops. The new version is remembered as `buh:last-good`, the one before as `buh:previous`.
4. **Not healthy:** it is removed, the old copy never stopped serving, and an alert is written. That image is not tried again; the next published version is.

While the copies switch, Caddy retries a request that cannot reach a copy on the other one, so customers and the Admin Hub see no error page. SMS codes, the catalogue and settings are shared through the database, so a code sent by one copy is accepted by the other.

### Turn on automatic updates (recommended)

The updater is off unless you turn it on. It checks for a new version every 15 minutes and keeps the shop running (see "Self-healing" below).

```bash
cd /opt/buhome && echo COMPOSE_PROFILES=autoupdate >> .env && docker compose up -d updater
```

Optional settings in `.env.production`, then `docker compose restart updater`:

- `UPDATE_CHECK_MINUTES=15`: how often to look for a new version; `0` means only when you ask.
- `ALERT_WEBHOOK_URL=https://…`: a Slack, Discord or similar webhook that gets a short message when an update succeeds or fails, or the shop is restarted.

If the image is private (pulling it asks for a password), give the updater a read-only GitHub token once:

```bash
docker compose exec updater docker login ghcr.io
```

The updater can control Docker on the server; [docs/security.md](docs/security.md) explains why that is acceptable and how it is limited.

### Update now

- With automatic updates on:
  ```bash
  docker compose exec updater update-now
  ```
- Without them (the same zero-downtime switch, once):
  ```bash
  docker compose run --rm updater update-now
  ```

To pick up changes to `docker-compose.yml` or the Caddyfile as well, run `git pull` first, then `docker compose up -d caddy updater` (Caddy restarts for a second only when its own settings changed). Use `docker compose up -d` without service names only for the first start: it also starts `app-blue` when `app-green` is the copy serving (the updater then stops one of them again).

### See what it did

- The updater's log:
  ```bash
  docker compose logs -f updater
  ```
- Which copy runs, the last good and previous versions, rejected versions:
  ```bash
  docker compose exec updater updater-status
  ```
- Alerts (one JSON line each, kept in the updater's own volume):
  ```bash
  docker compose exec updater cat /state/alerts/alerts.log
  ```

### Self-healing

Every 30 seconds the updater checks the copy that is serving:

- unhealthy for 3 checks in a row: it is restarted;
- still unhealthy after the restart: the other copy is started from `buh:last-good` and takes over, and the broken one is stopped (its log stays: `docker compose logs app-blue`);
- no copy running at all: one is started from `buh:last-good`.

Each of these writes an alert. To stop the shop on purpose (for a restore, section 4), stop the updater first: `docker compose stop updater`.

### Roll back

Automatic: a new version that does not become healthy is never switched to (above). To go back yourself, also without downtime:

- To the version before the current one:
  ```bash
  docker compose exec updater rollback
  ```
- To the last version that passed its checks:
  ```bash
  docker compose exec updater rollback buh:last-good
  ```
- To any published version (every version is kept as `ghcr.io/cxsmtp/buh:<version>`):
  ```bash
  docker compose exec updater rollback ghcr.io/cxsmtp/buh:1.2.0
  ```

Without automatic updates, use `docker compose run --rm updater rollback` the same way. A rolled-back version is not re-installed automatically; the next published one is.

Without the updater at all: start the copy that is not running from the last good image, wait until `docker compose ps` shows it `healthy`, then stop the other one (here green was running):

```bash
BUH_IMAGE=buh:last-good docker compose up -d --no-deps app-blue
```
```bash
docker compose stop app-green
```

**Database changes.** For a minute the old and new versions share the database, and a rollback runs the old version on it, so a release may only add to the database (new tables or columns), never remove or rename. To go back to the database exactly as it was before an update (orders placed since are lost), stop the updater and the shop as in section 4, then:

```bash
docker compose run --rm --no-deps app-blue sh -c 'cp /data/backups/pre-update-<time>.db /data/shop.db && rm -f /data/shop.db-wal /data/shop.db-shm'
```

### Moving from the older setup (one `app` container, before BUH-01.03.00)

Once, at a quiet time. The shop keeps serving except for a second or two while Caddy restarts with its new settings:

1. Get the new files:
   ```bash
   cd /opt/buhome && git pull
   ```
2. Start the new copy beside the old one:
   ```bash
   docker compose pull app-blue && docker compose up -d --no-deps app-blue
   ```
3. When `docker compose ps` shows `app-blue` as `healthy`, switch Caddy over and remove the old container:
   ```bash
   docker compose up -d --remove-orphans
   ```

The version (`BUH-xx.xx.xx`) shows next to the Admin Hub title.

## 6. Logs and health

- Logs:
  ```bash
  docker compose logs -f app-blue app-green
  ```
  Errors are logged with secrets redacted, and phone numbers and emails masked.
- State:
  ```bash
  docker compose ps
  ```
  The running copy shows `healthy` when `/api/health` answers.
- Audit log: `docker compose exec app-blue ls /data` (or `app-green`, whichever runs) lists the `audit-YYYY-MM.jsonl` files (one line per sign-in, order change, booking, setting change and backup).

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
5. **Containers:** the shop runs read-only, as non-root, with every Linux capability dropped. Only Caddy is reachable from outside. The optional updater can control Docker on the server and has no network listener.
