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

## Outbound calls (SSRF)

URLs an admin can type (SMS webhook, Infobip base URL) must be https, use port 443, carry no credentials, and resolve only to public addresses.

- **IPv4:** loopback, private, link-local (cloud metadata), CGNAT, reserved and multicast ranges are refused.
- **IPv6:** only global unicast is allowed, without 6to4, Teredo or documentation ranges. IPv4-mapped forms are judged by the IPv4 address inside them.
- **No DNS rebinding:** the address check runs inside the connection's own DNS lookup, so the address checked is the address connected to.
- **Every call:** redirects are not followed, there is a timeout, and replies are read only up to a size cap.

Carrier endpoints are fixed in code.

## Couriers

- Live bookings use the carrier's own AWB. If the carrier is down or refuses, the booking fails visibly. Older builds invented a random AWB and marked the order booked, and checkout gave every new order a made-up AWB and tracking link.
- **Never booked twice:** live bookings are kept by order number in `DATA_DIR/bookings.json`. A repeat request returns the AWB already issued. If the carrier never answered an attempt, it may or may not exist: the owner must check the carrier portal and confirm before booking again.
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
- **Back up `DATA_DIR`.** It holds the admin account, session key, booking record and audit log, with owner-only permissions (an existing folder is tightened to 700 at start).

## Known limits (next steps)

- **Demo orders and customers ship only in development builds** (or with `NEXT_PUBLIC_DEMO_DATA=true`).
- **Orders, products and customers are still stored in each browser's localStorage.** A customer's order is not seen by the admin on another device, and the phone-verified gate runs in the customer's browser. Moving orders to a server-side store (with server-side price checks and the OTP result bound to the order) is the most important next change.
- **Courier and SMS keys entered in the admin hub are kept in the admin's browser** and sent to the server for each call. Server-side, write-only settings would be better.
- **One admin account; no roles yet.**
