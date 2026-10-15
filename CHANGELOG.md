# Changelog

## BUH-01.03.00 — 2026-10-15 09:00 UTC · [#NN](https://github.com/cxsmtp/buh/pull/NN)

- **Updates without closing the shop.** The shop now runs as one of two identical copies (blue and green); a new version starts beside the one serving customers and takes over only once it is healthy, while Caddy retries any request caught in the switch on the other copy.
- **A bad version never goes live.** If the new version does not pass its health check and load the home page within 2 minutes, it is removed, the old one keeps serving, an alert is written, and that version is not tried again until a newer one is published.
- **The shop heals itself.** With the updater on, a copy that stops answering is restarted; if that does not help, the last version that worked (`buh:last-good`) is started and takes over, and a shop with nothing running is started again.
- **A database snapshot before every update.** `backups/pre-update-<time>.db` is taken by the running shop before any switch (no snapshot, no update); the newest 5 are kept.
- **Opt-in auto-updates, rollback in one command.** `COMPOSE_PROFILES=autoupdate` turns on the updater (checks every 15 minutes; alerts in the shop's data folder and, optionally, a webhook); `update-now` and `rollback` switch on demand without downtime. Existing servers move over once, as the deployment guide describes (a second or two while Caddy restarts).
- **Proven in CI.** Every pull request switches real containers under load with zero failed requests, rolls back two kinds of broken image while the old copy keeps serving, and restarts a stopped shop.
- **Status.**
  - **Benchmark:** same host, main vs this branch, 3 rounds each, alternating (the shop's code is unchanged apart from the version). Storefront main 535 / 730 / 554 req/s, branch 561 / 694 / 803. Serviceability main 482 / 576 / 694, branch 511 / 644 / 573. Catalogue main 625 / 757 / 824, branch 704 / 766 / 701. Level within the spread of a busy host; 0 failed requests in every run.
  - **Tests:** 133 passed, including 10 new updater tests against a fake Docker CLI and 3 for the database snapshot. The switch with real containers and Caddy runs only in CI (no Docker daemon here).
  - **Dependency audit:** production 0 vulnerabilities; no dependency changes.
  - **Security scan:** no automated scanner here. The updater holds the Docker socket (root-equivalent), so it is opt-in; why and how it is limited is in docs/security.md.

## BUH-01.02.00 — 2026-10-15 07:19 UTC · [#3](https://github.com/cxsmtp/buh/pull/3)

- **A ready-made container image.** Every change on main is built, started and checked, then published as `ghcr.io/cxsmtp/buh:latest` (plus a tag per version), so the server and your own computer can pull it instead of building it.
- **Test it on Windows with Podman.** `scripts\run-local-podman.bat` pulls the image and runs it at http://localhost:3000 in test mode (SMS codes on screen), keeping its data between runs.
- **The support email and shop address are read when the shop starts.** They were fixed at build time, so the email shown to international customers ignored `.env.production`; now one image works for any shop.
- **Status.**
  - **Benchmark:** same host, main vs this branch, 3 rounds each, alternating. Storefront main 750 / 868 / 844 req/s, branch 839 / 891 / 793 (p50 66–77 vs 66–76 ms). Serviceability main 606 / 734 / 663, branch 657 / 621 / 722. Catalogue main 685 / 777 / 773, branch 703 / 787 / 823 (p95 145–169 ms on the branch; main's first round had a 391 ms tail). 0 failed requests in every run.
  - **Tests:** 120 passed, including a new test that starts the real build with a different support email and shop address (it fails on the previous code).
  - **Dependency audit:** production 0 vulnerabilities; the same 5 dev-only ESLint findings as main.
  - **Security scan:** no automated scanner here. The image is smoke-tested in CI running read-only, as a non-root user, with every capability dropped.

## BUH-01.01.00 — 2026-10-14 19:58 UTC · [#2](https://github.com/cxsmtp/buh/pull/2)

- **Orders are kept on the server.** Every order, product, setting and booking is stored in a database on the server, so the owner sees every customer's order in the Admin Hub on any device. Prices, totals and stock are worked out there; a forged price is ignored, a double tap gives one order, and the last item can't be sold twice.
- **Customers pay the total they were shown.** If a price changes while someone is at checkout, the order is refused (nothing taken) and the bag reloads with the new total. Totals are summed in fils, and the bag no longer shows a delivery fee that was never charged.
- **Backups every 12 hours, by email.** The full database, Excel-ready CSV files (orders, items, customers, products), receipts, photos and the audit log, encrypted with `BACKUP_PASSPHRASE`, emailed to `BACKUP_EMAIL`, with the newest 14 kept on the server. Courier and SMS keys are left out. A status line in the Admin Hub shows the last backup, and **Back up now** runs one. A failure is emailed once, not every 15 minutes.
- **Safer stock and orders.** A stock edit can no longer undo a sale made meanwhile. One order holds at most 20 of a product, and a phone can have at most 3 orders waiting for confirmation.
- **Real bank details only.** No demo account is shown: bank transfer appears at checkout once the real bank name, account name and IBAN are saved. Checkout shows your bank name and instructions, and the IBAN's check digits are verified.
- **SMS gateway you choose is the one used.** Unifonic is removed (it looked active but sent nothing), and a gateway can't be switched on with missing fields.
- **Admin Hub fixes.** SMS settings can now be reached from a phone (bottom bar), and every tab fits a 375 px screen. Phone photos are shrunk before upload, so they save. "Ready for Dispatch" shows only on confirmed orders. You are warned before booking an unpaid transfer, or cancelling an order already booked with a courier.
- **Deployment:** one Hostinger KVM VPS with Docker Compose (the shop plus Caddy for automatic HTTPS), data in one volume, a restore script and guide.
- **Status.**
  - **Benchmark:** same host, main vs this branch, 3 rounds each. Storefront main 769 / 729 / 605 req/s, branch 753 / 662 / 729 (p50 79–86 vs 82–88 ms). Serviceability API main 591 / 495 / 490, branch 568 / 598 / 525. New catalogue API (`/api/products`, absent on main, so main's runs show it as failed) 745 / 607 / 714 req/s, p50 128–162 ms. 0 failed requests on every branch run.
  - **Tests:** 118 passed: unit tests, plus end-to-end tests against the production build and real-browser tests in Chromium at 375 px and 1280 px. Each review finding has a test that fails without its fix.
  - **Dependency audit:** production 0 vulnerabilities (nodemailer upgraded to 10.1.1). The full audit lists the same 5 high findings in ESLint's dev-only chain as main.
  - **Security scan:** two independent reviews (security, correctness) of this change; every finding fixed or explained in the pull request. No automated scanner is available here.

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
