# Changelog

## BUH-01.00.00 — 2026-10-14 17:23 UTC · [#1](https://github.com/cxsmtp/buh/pull/1)

- **Orders need a verified UAE mobile.** Customers confirm their number with a free 6-digit SMS code before **Confirm & Raise Order** unlocks: six code boxes that accept pasting and autofill, a resend timer and a clear verified badge. Anyone with a non-UAE number gets a one-tap email to the shop with their bag listed.
- **The admin password is no longer in the page.** Sign-in is checked on the server, with lockout after 5 wrong attempts; the first start prints a one-time password that you replace at first sign-in. The old shared password stops working.
- **Only signed-in admins can book couriers or send test SMS.** Every admin action is checked on the server, refuses requests from other sites, and is written to a tamper-evident audit log.
- **Courier bookings never invent a tracking number.** If Jeebly or Eco Express refuses or is down, you see why and the order stays unbooked. Sandbox AWBs are labelled simulated.
- **SMS codes can't be abused.** Codes go only to UAE numbers, are 6 digits, single use and limited per number, per address and shop-wide. They are never shown in the browser in production, and callers can no longer choose where codes are sent.
- **Fewer crashes.** Opening and closing checkout or a product no longer risks a React error, and a damaged browser save no longer breaks the shop.
- **Hardened deployment.** Security headers on every page, Docker running read-only and non-root, nginx limits for sign-in and codes, a health endpoint, and the build version (BUH-xx.xx.xx) in the admin hub.
- **Status.** Benchmark on the same host, main → this branch, two rounds: storefront 785/848 → 826/805 req/s (p50 80/76 → 77/70 ms, p95 128/107 → 125/108 ms); serviceability API 598/601 → 574/577 req/s (about 4% lower, from input validation and rate limiting); 0 failed requests in every run. Tests: 26 passed (22 unit, 4 end-to-end against the production build). `npm audit --omit=dev`: 0 vulnerabilities; the full audit lists 5 high in ESLint's dev-only dependency chain (braces), the same as main. Lint: 3 errors left, all react-hooks/set-state-in-effect from before this change (down from 9). Security scan: no new Checkmarx One scan (not available in this environment). Container image not built here (no Docker daemon); compose file validated.
