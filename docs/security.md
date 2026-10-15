# Security

What protects the shop, how it works, and what the owner must do. Each item has a test in `test/`.

## Admin hub

| What | How |
| --- | --- |
| **Sign-in checked on the server** | `/api/admin/login` verifies an scrypt hash (N=16384, r=8, p=1). Nothing about the credentials is sent to the browser. Older builds shipped the password in the page and trusted a `localStorage` flag; both are gone, and leftover keys are deleted on first load. |
| **First start** | With no `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`, a random one-time password is printed to the server log once, as the server starts. It must be changed at first sign-in; until then every other admin call is refused. |
| **Managed from the environment** | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`) to manage the account outside the app. |
| **Wrong passwords** | 5 in 15 minutes from one address pause sign-in for that email from that address for 15 minutes, so a stranger cannot lock the owner out from somewhere else. 50 in an hour from anywhere pause it everywhere (a spread-out guess). While paused, the password is not checked at all, so a pause never reveals that a guess was right. Unknown emails get the same answers, so they reveal nothing about which accounts exist. Behind nginx with `TRUST_PROXY=1`; without a trusted proxy every visitor counts as one address. |
| **Throttling** | 30 sign-in attempts per 10 minutes per address in the app; 10 per minute in nginx. |
| **Sessions** | HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, 8 hours. **Sign out** ends every session on the server (a copied cookie stops working), and so does changing the password. Rotating `ADMIN_PASSWORD_HASH` ends sessions too. |
| **Every admin route checks it** | Courier dispatch and test, SMS test and the AI studio all call `requireAdmin` on the server. |
| **Cross-site requests refused** | State-changing calls must come from this site (Origin / Referer / Sec-Fetch-Site, compared with the `Host` header; `X-Forwarded-Host` is never trusted), in addition to `SameSite=Strict`. |

## Admin password reset and email settings

- **Forgot password?** gives the same answer for any email (the admin email can't be discovered) and is limited to 5 an hour per address and 20 an hour in all. The link holds a random 256-bit token; only its SHA-256 is stored, it works once, for 30 minutes, and a new request replaces it. Using it ends every session and clears sign-in pauses. Accounts set by `ADMIN_EMAIL` get no link.
- The token is removed from the address bar as soon as the page opens.
- Changing the sign-in email needs the current password (counted like a sign-in attempt) and ends other sessions.
- The SMTP password is write-only, and is dropped when the server changes. A mail server typed in Settings must resolve to a public address (no loopback, private or cloud-metadata ranges), the shop connects to the address it checked, and the certificate is checked against the name. Ports: 25, 465, 587, 2525.

## Checkout phone verification

- **UAE mobiles only** (50, 52, 54, 55, 56, 58; `OTP_ALLOWED_PREFIXES`, default `+971`). Every way of writing a number (spaces, `00971`, `+971 0…`, Arabic digits) maps to one number and one set of limits. Other countries are shown the support email instead.
- **Codes:** 6 digits from `crypto.randomInt`, valid 10 minutes, single use, 5 guesses. Only an HMAC of each code is kept.
- **Limits against SMS-pumping fraud:** 1 code per number per 30 s and 5 per hour; 10 per address per hour; `OTP_MAX_PER_HOUR` (default 300) for the whole shop.
  - All limits are checked together and counted only when all allow the send, so a refused request uses up nothing.
  - The shop-wide counter cannot be pushed out of memory by a flood of other keys.
  - Reaching the shop-wide cap is written to the audit log (at most hourly).
- **If SMS is unavailable**, the gateway is down or the cap is reached, checkout cannot complete, by design: orders need a verified number. Customers are told to try again or email the shop, and the server log warns at start-up when no gateway is configured.
- **The browser cannot choose the gateway.** The public endpoint ignores any gateway settings in the request and uses the server's environment only. Older builds would post the code to any URL a caller supplied.
- **No code in the browser in production.** With no gateway configured, test mode shows the code on screen, but only outside production (or with `OTP_DEV_MODE=true`).
- **Firebase Phone Authentication (optional).** Google sends and checks the code; the browser then posts a Firebase ID token to `/api/otp/firebase`. The server verifies it with Node's crypto (no Firebase SDK on the server):
  - RS256 only, with a key id Google publishes (certificates cached for their `max-age`, refetched at most once a minute for an unknown key id, 10 s timeout);
  - issuer and audience must be this shop's project, so a token from any other Firebase project is refused;
  - not expired, not issued in the future (60 s skew), signed in by phone within the last 10 minutes, with a `phone_number`;
  - the number must still be a UAE mobile. The answer is the same signed phone token as the shop's own codes.
  - The route is closed unless Firebase is the switched-on SMS option, is same-origin only, size-capped and limited to 30 attempts per address per 15 minutes. Firebase's own abuse limits apply to sending; the shop's per-number send limits do not.
  - The web config (API key, auth domain, project ID, app ID) is public by design. Protect the project in Firebase: authorized domains set to the shop only, a Google Cloud budget alert, and (optionally) SMS region policy allowing only the UAE.

## Outbound calls (SSRF)

URLs an admin can type (SMS webhook, Infobip base URL) must be https, use port 443, carry no credentials, and resolve only to public addresses.

- **IPv4:** loopback, private, link-local (cloud metadata), CGNAT, reserved and multicast ranges are refused.
- **IPv6:** only global unicast is allowed, without 6to4, Teredo or documentation ranges. IPv4-mapped forms are judged by the IPv4 address inside them.
- **No DNS rebinding:** the address check runs inside the connection's own DNS lookup, so the address checked is the address connected to.
- **Every call:** redirects are not followed, there is a timeout, and replies are read only up to a size cap.

Carrier endpoints are fixed in code.

## Couriers

- Live bookings use the carrier's own AWB. If the carrier is down or refuses, the booking fails visibly. Older builds invented a random AWB and marked the order booked, and checkout gave every new order a made-up AWB and tracking link.
- **Never booked twice:** each live booking is recorded on the order in the database. A repeat request returns the AWB already issued. If the carrier never answered an attempt, it may or may not exist: the owner must check the carrier portal and confirm before booking again.
- Sandbox AWBs are labelled simulated.
- One booking per order at a time.
- Inputs are allow-listed and length-capped.
- Every dispatch is audited.

## Requests and errors

- Bodies are size-capped per route (2 KB for codes, 256 KB for dispatch, 9 MB for the photo studio) and must be JSON objects.
- Image uploads must really be PNG, JPEG or WebP (checked by magic bytes); SVG is refused.
- Unexpected errors return a generic message. The details go to the server log, with secrets redacted and phones/emails masked.

## Audit log

`DATA_DIR/audit-YYYY-MM.jsonl` records sign-ins, refusals, password changes, courier dispatches and tests, and SMS tests. Each line carries an HMAC over the previous line, so editing, deleting or reordering a line is detected (`verifyAuditLog`).

## Headers

Every page sends:

- **Content Security Policy:** scripts and connections only to this site, no plugins, no `<base>`, no framing.
  - Exception, for Firebase phone sign-in: reCAPTCHA scripts and frames (`www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`, `recaptcha.google.com/recaptcha/`), `apis.google.com`, frames from `*.firebaseapp.com`, and connections to `identitytoolkit.googleapis.com` and `securetoken.googleapis.com`.
  - **Trade-off:** the policy is fixed at build time (a per-request one costs too much, below), so these Google hosts are allowed even while Firebase is off. They are Google-run, path-limited where CSP allows, and nothing on the page loads from them unless Firebase is switched on. A custom auth domain (not `<project>.firebaseapp.com`) is not covered; keep the default.
- `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy: same-origin`, HSTS, and a `Permissions-Policy` that allows only geolocation (for the address pin).
- API responses add `Cache-Control: no-store`.

**Why there is no nonce CSP.** A per-request nonce would also block injected inline scripts, but it renders every page per request. On this shop the storefront fell from ~790 to ~145 requests/s, and even an idle proxy cost ~35%. React escapes all rendered text and there are no raw-HTML sinks, so the static policy is the better trade.

## Deployment

- **Docker:** non-root, `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, bound to `127.0.0.1`, data in a volume, healthcheck on `/api/health`.
- **Two copies, one serving.** `app-blue` and `app-green` share one definition (same image, settings, volume and hardening). Caddy health-checks both every 2 s and sends traffic to the first healthy one; both run only for the minute of an update, on the same SQLite database (WAL mode, one host: safe for two processes).
- **The updater is opt-in and powerful.** It is off unless the owner enables the compose profile `autoupdate`. It mounts the Docker socket, which gives it root-equivalent control of the host: whoever controls the updater controls the server. That is acceptable because it:
  - runs no network listener and talks only to the Docker socket and the registry (`ghcr.io`), plus the alert webhook if one is set (https only, 10 s timeout);
  - runs a fixed, pinned image (`docker:27.3.1-cli`) and the script from this repository, mounted read-only; nothing it pulls is executed by it, only started as the shop;
  - reads only `UPDATE_CHECK_MINUTES` and `ALERT_WEBHOOK_URL` from `.env.production`, so the shop's secrets are not in its environment (it can still read the file: the project folder is mounted read-only, because `docker compose` needs it);
  - has a read-only root filesystem, `no-new-privileges`, and only the `CHOWN`, `DAC_OVERRIDE` and `FOWNER` capabilities (to write its alert log into the shop's volume for the shop's user).
  The protection that matters is the server's: SSH keys only, and nobody else with access to Docker on it.
- **Updates never skip the safety checks.** The database is snapshotted before a switch (no snapshot, no switch); a new version must pass its health check and render the home page before it gets traffic from the old one; a version that fails is removed, remembered and not retried. Alerts go to the updater's own volume (`/state/alerts/alerts.log`; the updater has no access to the shop's data volume and no Linux capabilities) and, optionally, the webhook. Versions before 2.0.0 cannot be rolled back to on a 2.0 database (stock is per size); the updater refuses them. No secrets are written to either.
- **Database changes must be additive.** During a switch the old version runs against the new version's database, and a rollback runs it there for good: migrations add tables or columns, never drop or rename.
- **Published image** (`ghcr.io/cxsmtp/buh`): built by GitHub Actions from main only, after a smoke test that starts it read-only, as user 1001, with every capability dropped. Pull requests build and test it but never publish. No secrets are baked in: the support email and shop address are read from the environment at start-up.
- **PM2:** one instance. Codes and limits live in process memory; move them to Redis (or the database) before running more. For the same reason, an SMS code sent in the minute of a blue/green switch may have to be requested again.
- **`TRUST_PROXY=1`** only behind nginx, which sets `X-Real-IP`. Without a trusted proxy, per-address limits are skipped (not shared by everyone); the per-number, per-account and shop-wide limits still apply.
- **Back up `DATA_DIR`.** It holds the database, uploaded photos, receipts, backups, the admin account, session key and audit log, with owner-only permissions (an existing folder is tightened to 700 at start).

## Orders, prices and stock

- **Orders are stored on the server**, in a SQLite database in `DATA_DIR/shop.db`. It runs in WAL mode with full sync on commit, so a confirmed order survives a power cut.
- **The server works out what the customer pays.** It takes each line's product, bed size and quantity and computes the unit prices, totals and fees from the catalogue. A forged price in the request is ignored.
- **Stock is reserved in the same transaction** (`UPDATE … WHERE stock >= qty`), so two customers can never both buy the last set. Cancelling an order puts its stock back.
- **Every order needs proof of the phone number:** a signed, 30-minute token issued by `/api/otp/verify`. A number that was not verified by SMS cannot be put on an order.
- **One checkout attempt = one order.** The browser sends a random checkout reference, and a double tap or network retry gets the same order back.
- **Status changes follow allowed steps.** For example, a confirmed order cannot jump to delivered, and cancelled or delivered orders are final. Each change is recorded per order and in the audit log.
- **Track Order needs the order number and the phone number on it**, and shows status and delivery only (no address, email or full name). Lookups are limited per address and per order number.
- **Bank-transfer receipts** (PNG, JPEG, WebP or PDF, checked by their first bytes, max 5 MB) are stored on the server and shown only to the admin, sandboxed.

## Settings and keys

- **Branding, bank details, courier keys and SMS gateway settings** are stored on the server, so every visitor sees the same shop.
- **Keys are write-only.** The admin hub gets them back blank, with a "saved" flag. A save with a blank key keeps the stored one, and `null` clears it.
- **A key follows its host:** changing the Infobip or webhook address without a new key drops the old key.
- **"Test connection" fills blank keys from the saved ones on the server**, so the keys never travel back to a browser. A saved key is only filled in for the host it was saved for: a test aimed at a new address must bring its own key.

## Backups

Every 12 hours (see the deployment guide) the shop backs itself up:

- **A consistent database snapshot**, integrity-checked before it is used.
- **CSV flat files.** A cell starting with `= + - @` is prefixed with `'`, so Excel never runs it as a formula.
- **Receipts, photos and the audit log**, with a SHA-256 manifest.
- **Encryption (strongly recommended):** AES-256-GCM, with the key derived by scrypt (cost 2^17) from `BACKUP_PASSPHRASE`. The Admin Hub turns amber, and the log warns, while backups are emailed unencrypted or the passphrase is shorter than 12 characters.
- **Courier and SMS keys are blanked** in the backup's copy of the database (and the copy is vacuumed, so the old values are not left in free pages). Re-enter them after a restore.
- **A failure is emailed** when it starts, when the error changes and then once a day; the shop retries hourly.
- **Delivered by email over TLS** (STARTTLS is required, so the SMTP password is never sent in clear).
- **Kept on the server too:** the newest 14.
- **Session keys and the admin account are not in backups.** Restore accepts only the known file names, so a crafted backup cannot plant a key or an admin account.
- **Restore checks before it writes:** every file against the manifest, and the database's integrity. An encrypted backup is also authenticated (GCM); a plain `.tar.gz` can only be checked for damage, not tampering.

## Orders and stock

- **The customer is charged the total they saw.** Checkout sends the total it showed; if a price changed meanwhile, the server refuses the order (nothing taken) and checkout reloads the bag with the new total.
- **At most 20 of one product per order, and at most 3 unconfirmed orders per phone**, so one verified number cannot tie up the stock.
- **Stock edits cannot undo a sale:** the Admin Hub sends the stock it showed, and the server refuses the edit (409) if a sale happened in between.
- **Bank transfer is hidden until the real account is saved.** The IBAN must be a UAE IBAN that passes the mod-97 check.

## Public data and outbound calls added in BUH-02.00.00

- **Public endpoints show only what the shop shows:** `/p/<id>`, `/feeds/meta.csv` and `/sitemap.xml` list visible products only (hidden and removed ones are left out); `/api/events` sends change counters for the catalogue and settings, never order data (the admin stream `/api/admin/events` needs sign-in).
- **Fixed outbound URLs only:** exchange rates (open.er-api.com, daily) and public holiday calendars (calendar.google.com, weekly) are fetched from fixed addresses with timeouts and size caps; replies are validated and a bad match is rejected. Nothing a visitor or admin types is fetched.
- **Settings history never keeps keys:** saved versions have courier and SMS keys blanked; restoring one keeps the keys saved now.
- **SMS codes** are stored hashed (keyed with the shop's own secret), single use, 10 minutes, in the database, so both copies of the shop during an update check them the same way.
- **Customer details at checkout** are remembered in the customer's own browser only (never the phone check), with **Not you? Clear them**.

## Known limits (next steps)

- **One admin account; no staff roles yet.**
- **One server process, except briefly during an update.** Phone codes are stored hashed in the database, so both copies accept them; rate limits are per process, so during the overlap of an update a limit can briefly allow up to twice its count.
