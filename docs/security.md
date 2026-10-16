# Security

What protects the shop, how it works, and what the owner must do. Each item has a test in `test/`.

## Admin hub

| What | How |
| --- | --- |
| **Sign-in checked on the server** | `/api/admin/login` verifies an scrypt hash (N=16384, r=8, p=1). Nothing about the credentials is sent to the browser. Older builds shipped the password in the page and trusted a `localStorage` flag; both are gone, and leftover keys are deleted on first load. |
| **First start** | With no `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`, a random one-time password is printed to the server log once, as the server starts. It must be changed at first sign-in; until then every other admin call is refused. |
| **Managed from the environment** | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`) to manage the account outside the app. |
| **Wrong passwords** | Wrong recovery codes count together with wrong passwords. 5 in 15 minutes from one address pause sign-in for that email from that address for 15 minutes, so a stranger cannot lock the owner out from somewhere else. 50 in an hour from anywhere pause it everywhere (a spread-out guess). While paused, the password is not checked at all, so a pause never reveals that a guess was right. Unknown emails get the same answers, so they reveal nothing about which accounts exist. Behind nginx with `TRUST_PROXY=1`; without a trusted proxy every visitor counts as one address. |
| **Throttling** | 30 sign-in attempts per 10 minutes per address in the app; 10 per minute in nginx. |
| **Sessions** | HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, 8 hours. **Sign out** ends every session on the server (a copied cookie stops working), and so does changing the password. Rotating `ADMIN_PASSWORD_HASH` ends sessions too. The session generation starts at a random number in a new or restored data folder (backups never carry `session-state.json`, `session.key` or `admin.json`), so a cookie from before a restore can't come back to life even when `SESSION_SECRET` and `ADMIN_PASSWORD_HASH` are unchanged. |
| **Every admin route checks it** | Courier dispatch and test, SMS test and the AI studio all call `requireAdmin` on the server. |
| **Cross-site requests refused** | State-changing calls must come from this site (Origin / Referer / Sec-Fetch-Site, compared with the `Host` header; `X-Forwarded-Host` is never trusted), in addition to `SameSite=Strict`. |

## Admin password reset and email settings

- **Forgot password?** gives the same answer, just as fast, for any email: the email is sent after answering, so neither the words nor the timing reveal the admin email. Limited to 5 an hour per address, and at most 3 links an hour are sent for the account; asking again never cancels a link already sent, so a stranger can't lock the owner out of recovery. Each link holds a random 256-bit token; only its SHA-256 is stored, it works for 30 minutes, and using any one ends the others, every session and any sign-in pause. Accounts set by `ADMIN_EMAIL` get no link.
- The token is in the link's fragment (`/#reset=…`), which browsers never send to a server, so it stays out of access logs; the page removes it from the address bar at once.
- Changing the sign-in email needs the current password (counted like a sign-in attempt) and ends other sessions.
- The SMTP password is write-only, and is dropped when the server changes. A mail server typed in Settings must resolve to a public address (no loopback, private or cloud-metadata ranges), the shop connects to the address it checked, and the certificate is checked against the name. Ports: 25, 465, 587, 2525.

## Getting back in: recovery codes and passkeys

| What | How |
| --- | --- |
| **Recovery codes** | 10 per set, each 16 characters from a 32-letter alphabet without 0/O/1/I (80 random bits from `crypto.randomInt`), shown as `XXXX-XXXX-XXXX-XXXX` exactly once. Only a SHA-256 of each code is stored (table `admin_recovery_codes`): 80 random bits can't be guessed back from a hash, so a slow hash would only cost CPU per sign-in. A new set replaces the old in one transaction. |
| **Who can create codes** | A signed-in owner who types the current password again (counted like a sign-in attempt), or who signed in with a passkey in the last 10 minutes. A stolen session cookie alone can't mint a way back in. A wrong password is answered 400, so the owner stays signed in. |
| **Using a code** | Email + code at `/api/admin/login/recovery`. The code is used up by one `UPDATE … WHERE code_hash = ? AND used_at IS NULL`; SQLite applies it once, so a code works once even with two copies of the shop sharing the database (tested with two processes racing). Wrong codes count towards the same pause as wrong passwords (same keys, same limits); while paused the code is not looked at, so a pause reveals nothing and doesn't use a code up. A wrong email never reaches the codes. |
| **After a code** | Every other session ends. The new session lasts 30 minutes and can do one thing: choose a new password (same rules as a reset), without the forgotten one. The admin email is told a code was used (when mail is set up); the audit log records it with the address and how many are left, never the code. |
| **Codes when the password is in the environment** | With `ADMIN_PASSWORD_HASH` the password can't be changed in the app, so **a recovery code is a full key to the Admin Hub for 30 minutes**: orders, settings, couriers, everything. What that session can't do is change the ways in: adding, keeping or removing a passkey and creating new codes all need the current password (or a passkey sign-in in the last 10 minutes). Keep the codes as safe as the password itself. |
| **New password after a passkey** | Within 10 minutes of a passkey sign-in, the owner may choose a new password without the old one (Settings → Passkeys & recovery codes → Forgot your password?): the passkey's fingerprint/face/PIN check just proved it's them. After that, the current password is needed again. |
| **Passkeys** | WebAuthn via `@simplewebauthn/server` / `@simplewebauthn/browser` (exact versions). Only discoverable passkeys with user verification (fingerprint, face, PIN) are made and accepted; no attestation is asked for. Only the public key, counter, transports and a name are stored (`admin_passkeys`). Adding one needs the current password; removing one (effective at once) needs the current password or a passkey sign-in in the last 10 minutes. Adding one emails the admin. |
| **Which domain** | The relying-party ID and origin come from `NEXT_PUBLIC_APP_URL`, which must be `https://` (or `http://localhost`) and a domain name, never an IP. They are never taken from a request header, except that with no `NEXT_PUBLIC_APP_URL` a request whose `Host` is `localhost` may use `localhost` (a passkey for localhost only works in a browser on the same machine). Each passkey remembers the domain it was made for and only signs in there. |
| **Challenges** | Random, kept server-side (`webauthn_challenges`) for 5 minutes, used up by the first answer (`DELETE … RETURNING`, so a replay fails), and tied to the browser by an `HttpOnly`, `SameSite=Strict` cookie holding the challenge id and an HMAC of it. Adding a passkey is also tied to the session that asked. At most 10,000 live challenges; when full, the oldest sign-in challenges are dropped to make room, so starting a passkey sign-in is never refused. There is deliberately no shop-wide limit on it (a stranger could use one up and block the owner); a per-address limit applies behind a trusted proxy. Challenges are left out of backups. |
| **Copied passkeys** | When an authenticator keeps a signature counter, a counter that does not go up means a copy exists: the sign-in is refused, logged, audited and emailed to the admin. This is checked only after the signature is verified, so a forged answer can't set off alerts. Synced passkeys (iCloud, Google), which always report 0, are unaffected. |
| **Passkey sign-in during an attack** | A passkey can't be guessed, so a pause caused by wrong passwords or codes does not block it, and no shop-wide counter can be used up to block it: the owner still gets in while someone attacks the password. (To push out the owner's own challenge in the seconds a sign-in takes, an attacker would have to start thousands; the owner simply tries again.) The session is the same as after a password sign-in, and audited as `admin.sign_in` with `method: passkey`. |
| **After a restore** | A backup can be older than a passkey the owner removed (a lost phone) or a new set of codes, and nothing in it can tell. So `scripts/restore-backup.mjs` voids every restored recovery code and switches every restored passkey off (they stay listed; a sign-in with one is refused) until the owner, signed in with the password, presses **Keep** (password needed) or **Remove**. It prints a warning, and the Admin Hub shows a banner until the owner presses **Done**. This can't lock the owner out: a restore never brings back the admin account, so there is always a fresh one-time password in the log, or the `ADMIN_PASSWORD_HASH` password. A revocation stamp kept outside the backup was considered and rejected: a restore with `--replace` moves the whole data folder aside, and a restore onto a new server has nothing to compare with, so a stamp would protect only some restores. |
| **Only WebAuthn fields** | Every new route uses `readJsonBody` (size-capped), refuses unknown fields, and passes the library only the fields WebAuthn defines (base64url, length-capped). |

## Version switching from the Admin Hub

- The shop never controls Docker or Podman. It writes one line (`rollback 2.0.1` or `update`) to a request folder shared only with the updater, creating the file new (no overwrite, no links) and only one at a time. Admins only, 10 an hour, written to the audit log.
- The updater first moves the request into a new folder only it can open, so it can't be swapped for a link or a pipe while being read; it then accepts only a small plain file whose line matches `rollback N.N.N` or `update` exactly, and refuses versions before 2.0.0. Anything else is dropped unread and never echoed. The folder is sticky and not listable, so the shop can't remove or read anything else there.
- The updater's status comes back through a second folder the shop mounts read-only; it holds versions and messages, no secrets. The updater writes it to a new file and renames it, so a planted link is replaced, never followed. The shop reads it defensively (size cap, links refused, fields checked).

## Settings: autosave and the last good configuration

- Every save (typed or automatic) is validated on the server; an invalid change is refused and the stored settings are unchanged. Autosave never sends passwords or keys (blank means "keep the saved one"); only Save does.
- New mail settings are tried (SMTP login) before they are stored; if that fails while the current settings are known to work (a passing trial or test email), the change is refused (409). Known-good is kept as a hash, never a copy of the password.
- Autosaves within 2 minutes of each other are one history entry; Undo restores the entry before the session, and the restore itself is kept, so it can be undone.

## Delivery charges

- Whether we deliver, and any same-day charge, are decided on the server from the address and Settings → Delivery, in fils; a GPS reading never decides it (devices often report a network location). The browser's total must match the server's or the order is refused before anything is charged; a same-day order after the cut-off is refused (409) and checkout moves back to standard.

## Chat

- Each chat has a random id and a 192-bit secret kept in the customer's browser; only its SHA-256 is stored, and it travels in a header or the request body, never in an address. A wrong secret and an unknown chat get the same answer.
- Starting chats is limited per address (6 an hour) and shop-wide (300 an hour); messages to 40 per 10 minutes per address; a chat holds at most 300 messages of up to 1,000 characters. Text is shown as text, never as HTML.
- The owner is emailed at most once every 5 minutes per chat. Subjects carry only the chat's key and the customer's name/contact after control characters are removed.
- **Replies by email:** the mailbox (IMAP over TLS, port 993) is read once a minute. A server typed in Settings must resolve to a public address; the shop connects to the address it checked and verifies the certificate against the name. Only mail whose subject has a known `[Chat #KEY]` (10 random characters) is used, only the new text (not the quote), at most once per Message-ID. It counts as the owner's reply only from the owner's addresses (backup address, sign-in email, sender), and is refused when the receiving server reports DMARC failure (or SPF and DKIM both failing); otherwise only from the customer's own email, as the customer. The mailbox password is write-only and dropped when the server changes.
- The assistant answers only from the owner's text and the size presets; it never composes prices, discounts or promises.
- Owner replies and status changes are in the audit log; chats are in backups.

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
- **Single-container mode (Podman, on Windows or a Linux server) is the same trade-off.** The one-line `setup` mounts Podman's API socket into the published updater image (`ghcr.io/cxsmtp/buh-updater`: `docker:27.3.1-cli` plus `deploy/updater`, built and published from main like the shop), and the long-running updater keeps it. That gives it control of Podman, and so of every container and volume of that Podman user (rootless on a Windows Podman machine: the machine's user, not Windows itself; on a rootful Linux server: every container on the server, i.e. root-equivalent, as with Docker's socket). It runs `--read-only`, `--cap-drop ALL` plus only `CHOWN` and `FOWNER` (to take back its request and status folders: Podman's Docker API hands an empty volume to the user of the container that mounts it, the shop's), `no-new-privileges`, `--pids-limit 128`, no listener; `label=disable` only so that SELinux lets it use the socket. Its code is in the image; nothing on the host is read.
  - It updates itself from the same image name: the new updater must keep running and reach Podman before it takes over, otherwise it is removed and the image is not tried again. Trusting the updater image is trusting GitHub Actions on this repository's main branch, as for the shop image.
  - The HTTPS proxy (`ghcr.io/cxsmtp/buh-proxy`, Caddy 2.8.4) runs on the host network (it reaches the shop on `127.0.0.1`), as a non-root user, read-only, with every capability dropped except `NET_BIND_SERVICE` (ports 80 and 443) and `no-new-privileges`; its admin endpoint is off (on the host network it would be open to local users). It uses the same protections as the Compose Caddy (one shared file): the 12 MB body limit, `X-Real-IP` set from the connection (a visitor's own header is replaced), no `Server`/`X-Powered-By`, TLS 1.2 and newer (Caddy's defaults). HSTS and CSP come from the app and pass through once. The shop listens on `127.0.0.1` only and trusts `X-Real-IP` (`TRUST_PROXY=1`) because only the proxy can reach it.
  - The shop container is started only from a fixed definition: `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`, `--pids-limit 512`, the data volume, the request volume and the read-only status volume. The container name, port, volume names and extra `KEY=VALUE` settings come from the updater's environment and are checked strictly before anything runs (names `[A-Za-z0-9_.-]`, a port 1–65535, keys `[A-Z_][A-Z0-9_]*`, values without spaces, quotes or shell characters; `DATA_DIR`, `PORT`, `HOSTNAME`, `NODE_ENV` cannot be changed), and each is passed as its own argument, so no value can add a flag, a mount or a command.
  - It never moves the shop to other data: it refuses to touch a container whose `/data` is not the configured volume, and never starts a shop on a data volume that does not exist (only the first set-up of a new shop creates one).
  - The set-up carries the shop container's own settings over (its `-e` values, secrets included). They go to `docker run` as an env file in the updater's own volume (folder 700, file 600, root in the updater only), never on a command line, in the log, an alert or the status the shop reads; only their names are logged. Anything it cannot carry (another mount or port, a value with a line break) stops the set-up with a list, and nothing changes. `SHOP_ENV`, by contrast, is in the updater's environment: keep secrets out of it.
  - It never starts a second shop on the same data: nothing is started while another running container uses the data volume (the set-up also refuses a stopped one).
  - Requests are written whole to a temporary file and then linked into place (never replacing one), so the updater never reads a half-written request.
  - Requests and status work exactly as with Docker Compose ("Version switching from the Admin Hub", above): the shop can only drop one line into a sticky, non-listable folder and read the status. The set-up makes the updater (root in its container) the owner of both volumes before the shop mounts them.
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
- **Passkeys and recovery codes are in backups** (public keys and code hashes only, in the database). On restore the codes are voided and the passkeys switched off until the owner reviews them, because the backup may predate a revocation (see "After a restore" above). Unfinished passkey challenges are removed from the copy.
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
