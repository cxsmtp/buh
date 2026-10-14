# Changelog

## BUH-01.00.00 — 2026-10-14 17:55 UTC · [#1](https://github.com/cxsmtp/buh/pull/1)

- **Orders need a verified UAE mobile.** Customers confirm their number with a 6-digit SMS code before **Confirm & Raise Order** unlocks. The six code boxes accept typing, pasting into any box, phone autofill and Arabic digits, and show a resend timer and a clear verified badge. Anyone with a non-UAE number gets a one-tap email to the shop with their bag listed.
- **The admin password is no longer in the page.** Sign-in is checked on the server, and the first start prints a one-time password that you replace at first sign-in. 5 wrong passwords pause sign-in from that address for 15 minutes, so a stranger cannot lock you out from elsewhere and a pause never hints that a guess was right. Signing out ends the session everywhere.
- **Only signed-in admins can book couriers or send test SMS.** Every admin action is checked on the server, refuses requests from other sites, and is written to a tamper-evident audit log.
- **No made-up tracking numbers, and no double bookings.** New orders wait for a real AWB from Jeebly or Eco Express. A failed booking says why. A repeat booking returns the AWB already issued, and a booking the carrier never answered must be checked in the carrier portal before booking again.
- **SMS codes can't be abused.** Codes go only to UAE mobile numbers. They are single use and limited per number, per address and shop-wide, and a refused request never uses up anyone else's allowance. Codes are never shown in the browser in production, and callers can no longer choose where codes are sent.
- **Checkout fixes.**
  - Checkout can be closed again (✕ or Escape).
  - A second order in the same visit starts fresh.
  - Order numbers are unique (BUH-YYMMDD-XXXXXX).
  - An order the browser could not save is reported instead of confirmed.
  - Shoppers no longer see demo orders.
  - On phones the header fits the screen, with no sideways scrolling.
- **Hardened deployment.** Security headers on every page, Docker running read-only and non-root, nginx limits for sign-in and codes, a health endpoint, a startup warning when no SMS gateway is set, and the build version (BUH-xx.xx.xx) in the admin hub.
- **Status.**
  - **Benchmark:** same host, main vs this branch, 4 rounds each. Storefront main 777 / 746 / 759 / 643 req/s, branch 707 / 748 / 757 / 751 (median ≈ 750 for both; p50 81–87 ms for both). Serviceability API main 548 / 547 / 622 / 513, branch 598 / 467 / 501 / 497 (median ≈ 500 vs ≈ 547, about 9% lower, within this host's run-to-run spread of 18% on main alone). 0 failed requests in every run.
  - **Tests:** 76 passed: unit tests, plus end-to-end tests against the production build and real-browser tests in Chromium at 375 px and 1280 px.
  - **Audit:** `npm audit --omit=dev` finds 0 vulnerabilities. The full audit lists 5 high in ESLint's dev-only dependency chain (braces), the same as main.
  - **Lint:** 3 errors left, all react-hooks/set-state-in-effect from before this change (down from 9).
  - **Reviews:** independent security and correctness reviews; all 19 findings fixed with regression tests.
  - **Not run:** no new Checkmarx One scan (not available in this environment); container image not built here (no Docker daemon); compose file validated.
