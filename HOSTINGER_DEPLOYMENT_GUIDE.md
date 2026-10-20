# Hostinger Deployment Guide: Beautiful UAE Home

**Recommended model: one Hostinger KVM VPS running Docker Compose.** These containers run on it:

- the shop, as `app-blue` or `app-green`: two identical copies of one definition, of which one runs (both run for about a minute during an update);
- Caddy, which gets and renews the free HTTPS certificate and sends visitors to the copy that is healthy;
- optionally, the **updater**, which installs new versions without downtime, rolls back a version that does not start, and restarts the shop if it stops answering (section 5).

Everything the shop stores lives in one Docker volume and is backed up every 12 hours, by email.

| Option | Use it? | Why |
| --- | --- | --- |
| **KVM VPS + Docker Compose** (this guide) | ✅ Recommended | One command to start. Updates switch between two copies without closing the shop, and a version that fails is rolled back on its own. HTTPS is automatic. The database, photos and receipts persist in a volume. Backups run on their own. The shop containers run read-only, as non-root, with no extra privileges. |
| KVM VPS + Podman, images only | ✅ Supported | Nothing on the server but three published images (shop, HTTPS proxy, updater) and one settings file; set up with a few commands, then updates install themselves (a few seconds' pause at each switch). See "Hostinger VPS with Podman, images only". |
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
   - Fill in `DOMAIN`, `ACME_EMAIL`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPPORT_EMAIL`. `NEXT_PUBLIC_APP_URL` must be the `https://` address you open the shop at: Admin Hub passkeys only work there, and Google is given that address (sitemap, page addresses, IndexNow). Once the shop is live, connect Google Search Console once: Admin Hub → Settings → Search (SEO) has the steps ([user guide](docs/user-guide.md#search-seo-google-bing-and-the-festival-gift-pages)).
   - **Fill in the backup email (`SMTP_*`, `BACKUP_EMAIL`).**
   - The backup password is set in the Admin Hub (Settings → System & backups → **Protect backups with a password**: **Make one for me**, then save it in your password manager). `BACKUP_PASSPHRASE` here is optional: if set (at least 12 characters), it wins over the hub's. Without either, customer data is emailed unencrypted.
6. **Start** (pulls the ready-made image `ghcr.io/cxsmtp/buh:latest`):
   ```bash
   docker compose pull app-blue && docker compose up -d
   ```
   Then <https://yourdomain.ae> shows the shop with a valid certificate. To build the image on the server instead, use `docker compose up -d --build` (a few minutes).
7. **First admin sign-in.** The one-time password and your private **admin link** are in the log (the Admin Hub is only at that link, never on the shop's pages):
   ```bash
   docker compose logs app-blue | grep -A3 "first admin\|Admin link"
   ```
   Open the admin link, sign in with that email and password, then choose your own password. Bookmark the link on your phone and laptop (section "The private admin link" below).

### The private admin link

The Admin Hub has no button or address on the shop: addresses like `/admin` are an ordinary "not found". It is only at a private link like `https://yourdomain.ae/k7Qm2vXa9pTeLr4w…`.

- **Where it is:** printed in the log when it is made (the first start, or the update that brought it; it stays in `podman logs` until the container is removed), and emailed to the admin email when email is set up. An owner signed in during that update is taken to it once when they next open the shop.
- **Bookmark it:** on the phone, open it and Share → **Add to Home Screen** (iPhone) or ⋮ → **Add to Home screen** (Android); on the laptop, Ctrl+D (⌘+D). One link for both: the phone gets the phone view, the laptop the full view, and **Phone view / Laptop view** at the top switches it per device.
- **Change it:** Admin Hub → Settings → **Security** → **Change the admin link** (your password). The old link stops working at once; the new one is shown once and emailed.
- **Lost it?** Only a fingerprint is kept, so it can't be printed again, and "Forgot password" needs the link too: the only way back in is a new link, made on the server (SSH or hPanel's browser terminal). The old one stops working:
  ```bash
  podman exec beautifuluaehome node scripts/admin-link.mjs --new
  ```
- **Access logs** never hold it: the Caddy and nginx configs here log only its first 4 characters, and drop the redirect that moves a signed-in owner to a new link.
- **Scanners:** with `TRUST_PROXY=1`, an address that gets 10 "not found" answers in a minute is slowed, and at 30 refused (429) for 10 minutes. Shoppers never are (a taken-down product doesn't count), and neither is your own hub: a tab left open after the link was changed stops at once and says so.

## 2. Go-live checklist (in the Admin Hub)

- [ ] **Settings → Passkeys & recovery codes:** add a passkey on your phone, and create recovery codes (Download or Print them, keep them safe). They get you back in if you forget the password, even without email.
- [ ] **Settings → Store & contact:** your WhatsApp number (needed: customers confirm their orders by WhatsApp), support email and Instagram account.
- [ ] **Settings → Phone check:** **WhatsApp (free)** is already chosen: no SMS gateway or subscription is needed. Check the hours after which unconfirmed orders cancel themselves (24 by default).
  - At start-up, the log warns if no WhatsApp number is set (orders then come in marked "call the customer").
  - Only if you want SMS codes instead: choose **SMS code**, enter your Twilio or Infobip keys (or Firebase Phone Auth, billed per SMS; see docs/user-guide.md), **Send test** to your own mobile, then **Save**.
- [ ] **Settings → Branding & bank → Bank transfer details:** enter the bank name, account name and real IBAN, and check every digit. Bank transfer is hidden at checkout until they are saved, and the account is never shown on the website: each customer who chooses it gets it privately (email, WhatsApp, their order's private page).
- [ ] **Settings → Couriers:**
  - enter your pickup phone, unit, building, area, landmark and emirate;
  - enter the Jeebly sandbox (demo) keys, the live keys and the live address Jeebly gave you, then **Save Carrier Settings**;
  - press **Run the Sandbox check** and look at each step (it creates and cancels one TEST shipment in Jeebly's demo system);
  - press **Turn on Live mode** only when you are ready to book real pickups (it needs the live address and a passed Sandbox check);
  - add each size's packed weight in **Inventory** (Weight (g)), so parcels are weighed for you;
  - Eco Express: book in the Eco portal and use **Enter tracking number** on the order.
- [ ] **Inventory Stock:** add your products with their real pieces per size, and **Remove** the sample products.
- [ ] **Instagram / Facebook Shopping (optional):** add `https://yourdomain.ae/feeds/meta.csv` as a scheduled feed in Meta Commerce Manager.
- [ ] **Outbound access:** the server fetches exchange rates (open.er-api.com) daily and festival dates (calendar.google.com) weekly; if they are blocked, built-in festival dates are used and no local currency is shown.
- [ ] **Backups:** press **Back up now** at the top of the Admin Hub.
  - Check that the email arrives (with a backup password, one encrypted `.tar.gz.enc` file; without it, the CSV files and the `.tar.gz`).
  - The status line should be green.
- [ ] **Restore drill:** restore that backup on your computer (section 4), so you know it works before you need it.
- [ ] **A real test order:** place it from your phone, then confirm, book and cancel it in the Admin Hub.
- [ ] **Install it as an app on your phone** (needs the `https://` address): Android, browser menu → **Install app**; iPhone, Safari → Share → **Add to Home Screen**. The name and icon come from Settings → Branding ([user guide](docs/user-guide.md#install-the-shop-as-an-app)). If a proxy or CDN sits in front, it must not cache `/sw.js` (the shop sends `Cache-Control: no-cache`). Emergency switch for the app on phones: the setting `SW_RESET=true` (then restart the shop; see the user guide, "Install the shop as an app").
- [ ] **Uptime monitor:** use a free service (e.g. UptimeRobot) on `https://yourdomain.ae/api/health`.
- [ ] **Automatic updates** (recommended): turn on the updater (section 5).

**Chat replies by email (optional):** in Admin Hub → Settings → Email & admin account, fill in the mailbox (IMAP) server, e.g. `imap.hostinger.com`. Then replying to a chat email answers in the chat. Without it, reply in Admin Hub → Chats.

## 3. Backups (automatic, every 12 hours)

The shop backs itself up every 12 hours, and straight after a restart if one is due. It emails the backup to `BACKUP_EMAIL` and keeps the newest 14 on the server. Each backup contains:

- **The full database** (`shop.db`): every order, product, setting and booking. Courier, SMS and Stripe keys are blanked: re-enter them after a restore.
- **Flat files you can open in Excel:** `orders.csv`, `order_items.csv`, `customers.csv`, `products.csv`, `chats.csv`, `stock_moves.csv` (every stock change: who, why, old → new).
- **Bank-transfer receipts, product photos, and expenses with every bill photo** (`expenses.csv` too).
- **The audit log.**
- **A checksum manifest:** a damaged file is detected.

**Encryption:** with a backup password (set in the Admin Hub: Settings → System & backups → **Protect backups with a password**; or `BACKUP_PASSPHRASE` on the server, which wins), the email carries one AES-256 encrypted file instead of plain customer data. That is recommended, because email is not a safe place for customers' addresses and phone numbers. The hub's password is kept in `DATA_DIR/backup-secret.json` (owner-only), never in a backup. Changing it leaves older backups needing the old one; the restore names the date of the password a backup needs. Inside the running shop the restore script knows the current password by itself (`podman exec beautifuluaehome node scripts/restore-backup.mjs …`).

**Size:** one backup holds at most 6 GB of data (database, photos, receipts, bills, audit log); it is made and restored a piece at a time, so it needs disk, not memory. From 80% the Admin Hub and an email warn you; beyond it the backup is refused (and you are told) instead of making one too big to restore.

**Off-server copy (recommended):** the shop can also copy each backup, encrypted, to a Google Drive folder (Admin Hub → Settings → System & backups → **Copy each backup to Google Drive**; steps in docs/user-guide.md). Then a lost server can be rebuilt from Drive ("Hostinger VPS with Podman, images only" → "Rebuilding on a new server from Google Drive").

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

Then sign in with the new one-time password from `docker compose logs app-blue` at your admin link (the backup keeps it; a backup from before BUH-02.08 prints a new one in the log; if you changed the link after the backup, make a new one with `docker compose exec app-blue node scripts/admin-link.mjs --new`), and re-enter the courier and SMS keys. Restored passkeys are switched off and old recovery codes no longer work (the backup may be older than a passkey you removed): follow the banner in the Admin Hub to keep your passkeys and create new codes. Accountant access comes back switched off: re-invite your accountant (Settings → Security → Accountant access). Keys and the admin account are deliberately not in backups.

To check a backup on your own computer (Node 24, in a checkout of this repository after `npm ci`):

```bash
BACKUP_PASSPHRASE='your passphrase' node scripts/restore-backup.mjs buh-backup-….tar.gz.enc ./restored
```

Plain `.tar.gz` backups also open with any archive tool (`tar -xzf`). A restore needs free disk for the restored data plus 256 MB; on any problem it removes what it wrote.

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

- **From the Admin Hub** (with automatic updates on): Settings → **Versions** (or tap the version, bottom left) lists every release and what changed. **Switch to this version** goes to that one; **Update to the latest** comes back. Versions before BUH-02.00.00 can't run on today's database and are not offered.

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
  docker compose exec updater rollback ghcr.io/cxsmtp/buh:2.0.0
  ```

Without automatic updates, use `docker compose run --rm updater rollback` the same way. A rolled-back version is not re-installed automatically; the next published one is.

**Card payments and versions before BUH-02.09.00.** Those versions don't know card orders, so nothing checks or times them out there: switch card payments off in Settings → Payments before rolling back below BUH-02.09.00. Stripe keeps resending its webhooks (for up to 3 days) until a version that knows them is back.

**Bank transfer and versions before BUH-02.09.00.** Rolling back below BUH-02.09.00 republishes the bank account through the old public settings (the IBAN shows at checkout again): clear the IBAN in Settings → Branding & bank first if it must stay private.

**Measurements, colours and versions before BUH-02.10.00.** A product edited in an older version loses its **Fitted sheet** tick and **Other pieces** (that version doesn't know them): after updating again, open the product and tick or type them again. During the update minute (both versions running), a product with no colours ordered through the older one answers 409 "that colour is no longer offered"; the customer simply tries again. The older version never auto-cancels orders waiting for WhatsApp; the newer one does once it is back.

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

The version (`BUH-xx.xx.xx`) shows next to the Admin Hub title. After the update to BUH-02.08 the Admin Hub is only at its private link: `docker compose logs app-blue | grep "Admin link"`.

### Private images: log Podman in once

The images (`ghcr.io/cxsmtp/buh`, `buh-updater`, `buh-proxy`) are private. Podman needs a login to download them, and the updater uses the same login: every `setup` line mounts the folder that holds it (read-only), because Podman's Docker API does not use Podman's own login for the updater's downloads (tested with Podman 4.9 and 5.7).

1. **A token that can only read the images.** GitHub → your picture → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic). Tick only `read:packages`. Give it a long expiry (a year) and put the date in your calendar.
2. **Log in** (it asks for your GitHub name and the token as the password; the token is not shown):
   - Windows, in Command Prompt or PowerShell (kept in `%USERPROFILE%\.config\containers\auth.json`):
     ```bat
     podman login ghcr.io -u YOUR-GITHUB-NAME
     ```
   - Linux server, as root. `--authfile` matters: without it root's login is kept in `/run/user/0`, which is emptied at every restart:
     ```bash
     podman login ghcr.io -u YOUR-GITHUB-NAME --authfile /root/.config/containers/auth.json
     ```
     ```bash
     chmod 600 /root/.config/containers/auth.json
     ```
     (A rootless user: `--authfile ~/.config/containers/auth.json`.) The folder must belong to the user Podman runs as (root here): the updater runs as root without the right to read other users' files, and `setup` refuses, with the `chown` to type, if it cannot read it.
3. **When the token expires** (Settings → Versions then says "the registry login has expired"; updates wait, the shop keeps running): make a new token, run the same login line again, and that is all; the updater uses the new login at its next check. Delete the old token on GitHub.

`setup` checks the login before it changes anything, and says what is missing.

### One Podman container: automatic updates from images only

A shop that runs as one Podman container (no Caddy, no second copy), on a Windows laptop or on a Linux server, gets the same updater, published as an image: nothing is cloned or downloaded first, and no file is kept on the computer. It checks for a new version every 15 minutes, saves the database first, tries the new version beside the shop (same data, no port) and switches only when it answers; Settings → Versions can update or switch versions; a shop that stops is started again; and the updater keeps itself (and the HTTPS proxy, if any) up to date. One difference from the Compose setup: **at the switch the shop is closed for a few seconds** (the old container stops, the new one takes the port; behind the HTTPS proxy, visitors' requests wait for it instead of failing). If the new container does not answer, the old one is put back and an alert is written.

**Turn it on (Windows).** With the Podman machine running, one line (use your container's name if it is not `beautifuluaehome`; `podman ps` shows it). In **Command Prompt (cmd), not PowerShell**:

```bat
for /f "delims=" %S in ('podman info --format "{{if index .Host.RemoteSocket.Path 0 | eq 47}}{{.Host.RemoteSocket.Path}}{{else}}{{slice .Host.RemoteSocket.Path 7}}{{end}}"') do podman run --rm --pull=newer --security-opt label=disable -v %S:/var/run/docker.sock -e SOCK=%S -v "%USERPROFILE%\.config\containers:/run/buh/registry-auth:ro" ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
```

Or in PowerShell:

```powershell
$S = (podman info --format '{{.Host.RemoteSocket.Path}}') -replace '^unix://', ''; podman run --rm --pull=newer --security-opt label=disable -v "${S}:/var/run/docker.sock" -e "SOCK=$S" -v "$env:USERPROFILE\.config\containers:/run/buh/registry-auth:ro" ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
```

Both find Podman's socket, drop a leading `unix://` that some Podman versions print, pass the registry login folder (log in first: "Private images" above), and pull the newest updater image first (`--pull=newer`).

**Turn it on (Linux server).** See "Hostinger VPS with Podman, images only" below for the whole server; the line itself, with Podman's socket on (`systemctl enable --now podman.socket`), is:

```bash
S=$(podman info --format '{{.Host.RemoteSocket.Path}}'); S=${S#unix://}; podman run --rm --pull=newer --security-opt label=disable -v "$S:/var/run/docker.sock" -e "SOCK=$S" -v "$HOME/.config/containers:/run/buh/registry-auth:ro" ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
```

`setup` re-creates the shop container with two more volumes (requests and status for Settings → Versions), keeping its image, data volume, port binding (e.g. `127.0.0.1:3000` stays `127.0.0.1:3000`) and its own settings (every `-e` and `--env-file` value, secrets included: they are kept in a file in the updater's volume that only the updater can read, and never written to its log or output); the shop pauses for a few seconds. Then it starts the updater as `beautifuluaehome-updater` with `--restart=always`, and prints what it did. Run the same line again any time: a shop that is already set up is left as it is. Options after the name: `--minutes 0` (only when you ask), `--env "KEY=VALUE KEY=VALUE"` (add settings), `--volume NAME` and `--port PORT` (for a new shop), `--proxy DOMAIN --email ADDRESS` (HTTPS in front, Linux server). With `--proxy`, a new shop gets `TRUST_PROXY=1` and `NEXT_PUBLIC_APP_URL=https://DOMAIN`; an existing shop keeps its own settings, and `setup` points out when `TRUST_PROXY=1` is missing or `NEXT_PUBLIC_APP_URL` is another address, with the `--env` to add.

It changes nothing, and says why, when:

- the container keeps its data in another volume than `--volume` names, or in a host folder;
- another container also uses the data volume (two shops must never share one database: pass that container's name if it is the shop, or remove it);
- the container has something the updater cannot carry over, such as a folder or another volume mounted, or a port other than the shop's (it lists them; start the shop without them first).

**While automatic updates are on, update with "Update to the latest" in Settings → Versions** (or `update-now` below), not with the old `podman pull` / `podman run --replace` commands. If you do start the shop by hand, the updater notices within a minute and sets the container up again (same image and settings, a few seconds' pause), once; to do it all by hand, stop the updater first.

- The updater's log:
  ```bat
  podman logs -f beautifuluaehome-updater
  ```
- What runs, the last good and previous versions:
  ```bat
  podman exec beautifuluaehome-updater updater-status
  ```
- Update now:
  ```bat
  podman exec beautifuluaehome-updater update-now
  ```
- Roll back to the version before (it was kept as the stopped container `beautifuluaehome-previous`); below BUH-02.09.00, switch card payments off first (Settings → Payments), and know that the bank account is shown publicly again (clear the IBAN first to keep it private); below BUH-02.10.00, a product edited there loses its Fitted sheet tick and Other pieces (re-tick them after the update), and during the update minute a product with no colours ordered through the older version gets 409 (the customer tries again):
  ```bat
  podman exec beautifuluaehome-updater rollback
  ```
- Only install new versions when you ask: untick **Install new versions automatically** in Settings → Versions (the updater keeps healing the shop, and "Update to the latest" still works; the page shows when it last checked and what it found, and **Installed on this server** lists each version installed, with its digest, when and why).
- Remove the updater altogether (the shop keeps running):
  ```bat
  podman rm -f beautifuluaehome-updater
  ```

To stop the shop on purpose, stop the updater first (`podman stop beautifuluaehome-updater`), or it starts the shop again. Stopping the updater (or running `setup` again) lets a switch that is under way finish, up to 10 minutes; a new one is not started.

**The updater updates itself.** On the same schedule it pulls `ghcr.io/cxsmtp/buh-updater:latest`; a newer image is started beside it as `beautifuluaehome-updater-new`, checked (it keeps running and reaches Podman), and then takes over the name. The old one stays, idle, as `beautifuluaehome-updater-old` until the new one has done one full round (checked the shop and written the status for Settings → Versions); then the new one removes it. If the new one does not finish a round within 10 minutes, the old one removes it, takes the name back and goes on, writes an alert, and that image is not tried again. Never during a shop switch. If the new one does not even start, it is removed at once and the running updater carries on.

**The HTTPS proxy and the updater restart only when they changed.** Their images are built so that a release that does not touch them publishes the very same image, so most releases restart neither. A new proxy image means a pause of a second or two without HTTPS (the new proxy is created first, then the old one stops and the new one starts; both need ports 80 and 443); if it does not come up, the old one is started again and an alert is written.

**After a restart of the computer.** The shop and the updater have `--restart=always`, but Podman has no background service that starts containers at boot: per Podman's documentation, `--restart=always` containers come back after a reboot only through `podman-restart.service`, which is off by default. We have not been able to check this on a Windows Podman machine. So, once:

- Windows: let Podman Desktop start at login and start the machine (Podman Desktop → Settings → Preferences), and turn the service on inside the machine:
  ```bat
  podman machine ssh "loginctl enable-linger && systemctl --user enable podman-restart.service"
  ```
  (a rootful machine: `podman machine ssh "sudo systemctl enable podman-restart.service"`). If the shop still is not back after a restart, start the updater; it starts the shop:
  ```bat
  podman start beautifuluaehome-updater
  ```
- Linux server: `systemctl enable podman-restart.service` (in the server section below).

A shop on a version before BUH-02.00.00 has no database snapshot tool, so the updater does not switch away from it: update it once by hand (the two Podman commands in Settings → Versions). The updater controls Podman through its socket; [docs/security.md](docs/security.md) explains the trade-off. `scripts\podman-autoupdate.bat` (in a checkout) runs the same line for you.

**What was tested:** `setup`, the updater, its self-update and the proxy were tested with real containers against Docker, Podman 4.9 (Ubuntu 24.04) and Podman 5.7 (Ubuntu 26.04), through the same Docker-compatible API. Not on a Windows Podman machine: finding the socket, the restart after a reboot and the `podman machine ssh` line have not been seen working there.

## Hostinger VPS with Podman, images only

The shop on a Hostinger KVM VPS with Ubuntu 26.04 LTS (24.04 works too), from published images only: no code, no Compose, nothing cloned on the server. Three containers: the shop (on `127.0.0.1:3000`, not reachable from outside), `buh-proxy` (Caddy: HTTPS with free certificates, HTTP → HTTPS, www → the domain) and `buh-updater` (updates, self-healing; it keeps the other two and itself up to date). Log in as root (`ssh root@your-server-ip`); type each line on its own.

**No domain yet?** The server's own name, `srvNNNN.hstgr.cloud` (hPanel → VPS → Overview), works for HTTPS as a temporary domain: use it wherever `shop.example.com` appears below. To move to your own domain later (DNS pointing at the server first), run step 7 again with the new domain and its address:
```bash
podman run --rm --pull=newer --security-opt label=disable -v /run/podman/podman.sock:/var/run/docker.sock -e SOCK=/run/podman/podman.sock -v /root/.config/containers:/run/buh/registry-auth:ro ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome --proxy shop.example.com --email you@example.com --env "NEXT_PUBLIC_APP_URL=https://shop.example.com"
```

1. **Firewall in hPanel** (VPS → Security → Firewall): add a rule set that accepts TCP 22, TCP 80, TCP 443 and UDP 443, and drops everything else; activate it.
2. **Updates and Podman:**
   ```bash
   apt update && apt upgrade -y
   ```
   ```bash
   apt install -y podman unattended-upgrades ufw
   ```
3. **Podman's API socket, and containers back after a reboot:**
   ```bash
   systemctl enable --now podman.socket
   ```
   ```bash
   systemctl enable podman-restart.service
   ```
4. **The shop's settings** (one file, readable by root only from the moment it exists; replace the domain):
   ```bash
   install -d -m 700 /etc/buh && install -m 600 /dev/null /etc/buh/shop.env
   ```
   ```bash
   printf 'NEXT_PUBLIC_APP_URL=https://shop.example.com\nTRUST_PROXY=1\nTZ=Asia/Dubai\n' > /etc/buh/shop.env
   ```
   Other settings (`NEXT_PUBLIC_SUPPORT_EMAIL`, `BACKUP_PASSPHRASE`, …) go in the same file, one `KEY=value` a line, without quotes (`nano /etc/buh/shop.env`), before step 7: `setup` keeps a copy of the shop's settings, so later changes go in with `--env "KEY=value"` on the step 7 line. `TRUST_PROXY=1` is right only behind the proxy: it is the proxy that sets the visitor's address.
5. **The shop**, on this server only, with every protection:
   ```bash
   podman run -d --name beautifuluaehome --restart=always -p 127.0.0.1:3000:3000 -v beautifuluaehome-data:/data --env-file /etc/buh/shop.env --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 ghcr.io/cxsmtp/buh:latest
   ```
   (The images are private: log in first, as in "Private images" above: `podman login ghcr.io -u YOUR-GITHUB-NAME --authfile /root/.config/containers/auth.json`, then `chmod 600 /root/.config/containers/auth.json`.)
6. **The first admin password and the admin link** (printed once, on the first start; the Admin Hub is only at that link):
   ```bash
   podman logs beautifuluaehome
   ```
   Already running an older version? After the update, the same command shows the new admin link once (look for `Admin link:`). Lost it later:
   ```bash
   podman exec beautifuluaehome node scripts/admin-link.mjs --new
   ```
7. **Automatic updates and HTTPS** (replace the domain and the e-mail, where Let's Encrypt writes before a certificate expires). This starts the proxy and the updater:
   ```bash
   podman run --rm --pull=newer --security-opt label=disable -v /run/podman/podman.sock:/var/run/docker.sock -e SOCK=/run/podman/podman.sock -v /root/.config/containers:/run/buh/registry-auth:ro ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome --proxy shop.example.com --email you@example.com
   ```
   The domain's DNS (an `A` record for `shop.example.com`, and `www.shop.example.com` too) must point at the server first; the certificate follows within a minute. Then open https://shop.example.com.
8. **Harden the server.**
   - SSH with a key instead of a password: add your public key in hPanel (VPS → Settings → SSH keys), or from Windows PowerShell on your laptop:
     ```powershell
     type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@your-server-ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
     ```
     (no key yet: `ssh-keygen -t ed25519` first). **Then open a new window and check that `ssh root@your-server-ip` logs in without a password**, and only then turn passwords off; otherwise you lock yourself out (hPanel's browser terminal still works then). The file is named `00-` because the first value SSH reads wins over the server's own files (such as `50-cloud-init.conf`):
     ```bash
     printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-buh.conf
     ```
     ```bash
     sshd -t && systemctl reload ssh
     ```
     Check that it applies; it must print `passwordauthentication no` and `permitrootlogin without-password`:
     ```bash
     sshd -T | grep -Ei 'passwordauthentication|permitrootlogin'
     ```
   - Security updates install themselves:
     ```bash
     dpkg-reconfigure -f noninteractive unattended-upgrades
     ```
   - The server's own firewall too (allow SSH **before** turning it on):
     ```bash
     ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443
     ```
     ```bash
     ufw --force enable
     ```

Day to day: Settings → Versions in the Admin Hub; the commands in the section above (`podman logs -f beautifuluaehome-updater`, `podman exec beautifuluaehome-updater updater-status`); `podman logs -f beautifuluaehome-proxy` for HTTPS. A rootless Podman user instead of root also works: run steps 3 and 7 as that user with `systemctl --user enable --now podman.socket podman-restart.service` and `loginctl enable-linger`, and in step 7 use the socket that `podman info --format '{{.Host.RemoteSocket.Path}}'` prints; the proxy needs ports 80 and 443, which a rootless user may not open by default (`sysctl net.ipv4.ip_unprivileged_port_start=80`), so root is simpler.

**Moving the laptop shop to the server** (its orders, products, photos and settings):

1. On the laptop, in the Admin Hub: Settings → System & backups → **Back up now**. Then, in the Windows command prompt, list the backups and copy the newest out of the container and onto the server (use its real name):
   ```bat
   podman exec beautifuluaehome ls /data/backups
   ```
   ```bat
   podman cp beautifuluaehome:/data/backups/buh-backup-20261016-1200.tar.gz.enc .
   ```
   ```bat
   scp buh-backup-20261016-1200.tar.gz.enc root@your-server-ip:/root/
   ```
2. On the server: stop the updater, then the shop, and restore over the new shop's data (the data before is kept aside in `replaced-<time>/`). The passphrase is the laptop shop's backup password (from your password manager, or its `BACKUP_PASSPHRASE`); it is typed without showing and passed by name only, so it is not on a command line or in the shell history (a backup ending in `.tar.gz`, not `.enc`, needs none: press Enter):
   ```bash
   podman stop beautifuluaehome-updater && podman stop beautifuluaehome
   ```
   ```bash
   chmod 644 /root/buh-backup-20261016-1200.tar.gz.enc
   ```
   ```bash
   read -rs -p 'Backup passphrase: ' BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE
   ```
   ```bash
   podman run --rm -v beautifuluaehome-data:/data -v /root/buh-backup-20261016-1200.tar.gz.enc:/restore/buh-backup-20261016-1200.tar.gz.enc:ro -e BACKUP_PASSPHRASE --entrypoint node ghcr.io/cxsmtp/buh:latest scripts/restore-backup.mjs /restore/buh-backup-20261016-1200.tar.gz.enc /data --replace
   ```
   ```bash
   unset BACKUP_PASSPHRASE
   ```
   ```bash
   podman start beautifuluaehome && podman start beautifuluaehome-updater
   ```
3. Sign in with the new one-time password from `podman logs beautifuluaehome` (the admin account is not in backups) at your admin link (the backup keeps it; `podman exec beautifuluaehome node scripts/admin-link.mjs --new` makes a new one), re-enter the courier and SMS keys, and follow the Admin Hub's banner about passkeys (section 4).

**Rebuilding on a new server from Google Drive** (the old server is lost; needs the copies in Google Drive, your backup password (from your password manager), and either the four restore-details lines from "Connect my Google Drive" or the service account's `.json` key file):

1. Set up the new server with the steps above, up to the shop running (a new, empty shop).
2. On the server: stop the updater, then the shop:
   ```bash
   podman stop beautifuluaehome-updater && podman stop beautifuluaehome
   ```
3. Type the backup password without showing it, passed by name only (not on a command line):
   ```bash
   read -rs -p 'Backup passphrase: ' BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE
   ```

**With "Connect my Google Drive"** (the four lines you saved with **Copy restore details**):

4. Paste the four lines into a file only root can read, then save it (Ctrl+O, Enter, Ctrl+X):
   ```bash
   install -m 600 /dev/null /root/drive.env && nano /root/drive.env
   ```
5. Restore the newest copy over the new shop's data (`--from-drive list` instead of `--from-drive latest` lists the copies; a copy's name restores that one):
   ```bash
   podman run --rm -v beautifuluaehome-data:/data --env-file /root/drive.env -e BACKUP_PASSPHRASE --entrypoint node ghcr.io/cxsmtp/buh:latest scripts/restore-backup.mjs --from-drive latest /data --replace
   ```

**Or with a service account** (its `.json` key file):

4. Copy the key file to the server (from your computer), and load it by name only:
   ```bat
   scp drive-key.json root@your-server-ip:/root/
   ```
   ```bash
   export BUH_DRIVE_KEY="$(cat /root/drive-key.json)"
   ```
5. Restore the newest copy (put your folder's link in):
   ```bash
   podman run --rm -v beautifuluaehome-data:/data -e BACKUP_PASSPHRASE -e BUH_DRIVE_KEY -e BUH_DRIVE_FOLDER='https://drive.google.com/drive/folders/your-folder-id' --entrypoint node ghcr.io/cxsmtp/buh:latest scripts/restore-backup.mjs --from-drive latest /data --replace
   ```

Then, either way:

6. Forget the secrets in this shell, and start the shop and the updater:
   ```bash
   unset BACKUP_PASSPHRASE BUH_DRIVE_KEY
   ```
   ```bash
   podman start beautifuluaehome && podman start beautifuluaehome-updater
   ```
7. Sign in as in step 3 of "Moving the laptop shop" above, then in Settings → System & backups press **Connect Google Drive** again (or paste the key again: backups never carry the connection or the key), and press **Back up now**. Keep `/root/drive.env` in your password manager, then delete it: `rm /root/drive.env`.

To check the copies from the running shop (it uses its saved connection and folder): `podman exec beautifuluaehome node scripts/restore-backup.mjs --from-drive list`.

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

1. Install Node 24 (LTS) and the build tools for the SQLite module:
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

1. **The Admin Hub is hidden and its sign-in is checked on the server.** It is only at a private link (kept as a hash; every admin address is a plain 404 without it). Passwords are scrypt-hashed, the session cookie is HttpOnly, and sign-in pauses after 5 wrong attempts from one address. The first start prints a one-time password and the admin link to the log.
2. **Prices, stock and totals are computed on the server** from the catalogue. Every order carries a phone number proven by an SMS code.
3. **Every admin action is checked on the server** and audited. Courier and SMS keys are write-only: they never reach a browser.
4. **Security headers on every page:** a Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, HSTS and a tight `Permissions-Policy`.
5. **Containers:** the shop runs read-only, as non-root, with every Linux capability dropped. Only Caddy is reachable from outside. The optional updater can control Docker on the server and has no network listener.
