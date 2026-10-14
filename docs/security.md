# Security

What protects the shop, how it works, and what the owner must do. Each item has a test in `test/`.

## Admin hub

| What | How |
| --- | --- |
| **Sign-in checked on the server** | `/api/admin/login` verifies an scrypt hash (N=16384, r=8, p=1). Nothing about the credentials is sent to the browser. Older builds shipped the password in the page and trusted a `localStorage` flag; both are gone, and leftover keys are deleted on first load. |
| **First start** | With no `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`, a random one-time password is printed to the server log once. It must be changed at first sign-in; until then every other admin call is refused. |
| **Managed from the environment** | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`) to manage the account outside the app. |
| **Lockout** | 5 wrong passwords lock the account for 15 minutes. A wrong password always gets the same "Wrong email or password", whether or not the account exists or is locked. Only someone with the right password learns about the lock. |
| **Throttling** | 30 sign-in attempts per 10 minutes per address in the app; 10 per minute in nginx. |
| **Sessions** | HMAC-signed cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, 8 hours. Changing the password ends every other session. |
| **Every admin route checks it** | Courier dispatch and test, SMS test and the AI studio all call `requireAdmin` on the server. |
| **Cross-site requests refused** | State-changing calls must come from this site (Origin / Referer / Sec-Fetch-Site), in addition to `SameSite=Strict`. |

## Checkout phone verification

- **UAE mobiles only** (`OTP_ALLOWED_PREFIXES`, default `+971`). Other numbers are shown the support email instead.
- **Codes:** 6 digits from `crypto.randomInt`, valid 10 minutes, single use, 5 guesses. Only an HMAC of each code is kept.
- **Limits against SMS-pumping fraud:** 1 code per number per 30 s and 5 per hour; 10 per address per hour; `OTP_MAX_PER_HOUR` (default 300) for the whole shop.
- **The browser cannot choose the gateway.** The public endpoint ignores any gateway settings in the request and uses the server's environment only. Older builds would post the code to any URL a caller supplied.
- **No code in the browser in production.** With no gateway configured, test mode shows the code on screen, but only outside production (or with `OTP_DEV_MODE=true`).

## Outbound calls (SSRF)

URLs an admin can type (SMS webhook, Infobip base URL) must be https, use port 443, carry no credentials, and resolve only to public addresses. Loopback, private, link-local (cloud metadata), CGNAT and multicast ranges are refused. Redirects are not followed, every call has a timeout, and replies are read up to a size cap. Carrier endpoints are fixed in code.

## Couriers

- Live bookings use the carrier's own AWB. If the carrier is down or refuses, the booking fails visibly. Older builds invented a random AWB and marked the order booked.
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
- `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy: same-origin`, HSTS, and a `Permissions-Policy` that allows only geolocation (for the address pin).
- API responses add `Cache-Control: no-store`.

**Why there is no nonce CSP.** A per-request nonce would also block injected inline scripts, but it renders every page per request. On this shop the storefront fell from ~790 to ~145 requests/s, and even an idle proxy cost ~35%. React escapes all rendered text and there are no raw-HTML sinks, so the static policy is the better trade.

## Deployment

- **Docker:** non-root, `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, bound to `127.0.0.1`, data in a volume, healthcheck on `/api/health`.
- **PM2:** one instance. Codes and limits live in process memory; move them to Redis before running more.
- **`TRUST_PROXY=1`** only behind nginx, which sets `X-Real-IP`. Without a trusted proxy, per-address limits are skipped (not shared by everyone); the per-number, per-account and shop-wide limits still apply.
- **Back up `DATA_DIR`.** It holds the admin account, session key and audit log, with owner-only permissions.

## Known limits (next steps)

- **Orders, products and customers are still stored in each browser's localStorage.** A customer's order is not seen by the admin on another device, and the phone-verified gate runs in the customer's browser. Moving orders to a server-side store (with server-side price checks and the OTP result bound to the order) is the most important next change.
- **Courier and SMS keys entered in the admin hub are kept in the admin's browser** and sent to the server for each call. Server-side, write-only settings would be better.
- **One admin account; no roles yet.**
