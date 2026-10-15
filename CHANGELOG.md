# Changelog

## BUH-02.01.00 — 2026-10-15 10:49 UTC · [#5](https://github.com/cxsmtp/buh/pull/5)

- **A chat that answers, then hands over.** The new **Help** button answers sizes (from your size presets), delivery, payment, care, returns and discount questions from what you teach it in Settings → Chat assistant; anything else, an order problem, or "Talk to a person" comes to you, and it never makes up a price, discount or promise.
- **Chats in the Admin Hub and by email.** Admin Hub → Chats shows the chats waiting for you first, with a badge; you get an email for each, and replying to that email answers in the chat (once the mailbox is set in Settings → Email & admin account).
- **Nobody left waiting.** If no one answers within the waiting time (2.5 minutes by default), the customer is told once that you'll get back to them and asked for a phone or email; a reply you write after they've left is emailed to them.
- **The assistant's memory is yours.** Add, edit and remove its answers, try a question before saving, and download the memory as a file to keep or to load back.
- **Ask on WhatsApp, Instagram or in chat.** Each product offers the ways you switch on in Settings → Store & contact; Instagram copies the product's link for the customer to paste.
- **Chats are backed up.** The database and a `chats.csv` are in every backup, and the restore script brings them back; chats only the assistant handled are removed after 30 days.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.00.00) vs this branch, two sets of 3 alternating rounds, 0 failed requests in every run. Storefront main 922 / 855 / 860 / 791 / 801 / 751 req/s, branch 813 / 778 / 796 / 795 / 878 / 867 (level: the first set favoured main, the second the branch). Courier check main 614–826, branch 601–671. Catalogue main 733–911, branch 756–840. p95 within 103–207 ms on both.
  - **Tests:** 231: unit (assistant, chat, email replies, settings), a fake IMAP mail server over TLS, end-to-end on the production build, and real-browser chat from shopper to owner and back at 375 px and 1280 px, keyboard included.
  - **Dependency audit:** production 0 vulnerabilities (adds imapflow 2.1.2 and mailparser 3.9.32, both a few weeks old); the same 5 dev-only ESLint findings as main.
  - **Security scan:** an independent security and correctness review; all 9 findings fixed with tests (own notification or out-of-office never posted as a reply, owner replies need DKIM/DMARC pass, no sending password offered to another server, per-chat and owner-email limits, both copies claim emails atomically, no skipped replies, order problems go to a person, keyboard focus, a full chat can still be answered). No automated scanner here.

## BUH-02.00.00 — 2026-10-15 10:20 UTC · [#4](https://github.com/cxsmtp/buh/pull/4)

- **Inventory you can fully edit, stock per size.** Every product field (photos, text, prices, colours, sizes) is editable from a phone; stock is kept per size because most designs are one or two pieces, with one-tap + / −, "Only 1 left" and sold-out sizes for shoppers, and Remove (archive) that keeps past orders intact.
- **A settings console.** Store & contact (WhatsApp number, email, Instagram, TikTok, Facebook, address), Catalogue (size presets, categories, low-stock warning), Branding & bank, Festival themes, Phone verification, Couriers (and Firebase as an SMS option, with Google's signed answer checked on the server), and System (health, backups, and earlier versions of every setting, restorable in one click).
- **Festival themes for all of the UAE.** 33 festivals across the UAE's communities (the Eids and Ramadan, National Day, Diwali, Holi, Onam, Christmas, Easter, Lunar New Year, Nowruz, Hanukkah and more) switch the banner and scrolling bar automatically from 3 weeks before to 1 week after, with dates checked online weekly; you can pick a look, switch one off, or turn themes off.
- **Made for Instagram and WhatsApp.** Every product has its own link that previews with its photo and price; a WhatsApp button and "Ask on WhatsApp" use your number from Settings; a Meta/Google product feed (`/feeds/meta.csv`) and sitemap are served; each order records whether the customer came from Instagram, WhatsApp, TikTok or elsewhere.
- **Customers carry on where they left off.** The bag and their delivery details are remembered, a bag can be sent as a link (for moving from Instagram's in-app browser to Safari or Chrome), prices outside the UAE show an approximate amount in the visitor's currency next to AED, and stock, prices and settings update on open pages within seconds without a reload.
- **Updates without closing the shop, healing itself.** A new version starts beside the one serving, takes over only when healthy, and is rolled back automatically if not; a database snapshot is taken first; a stuck copy is restarted or replaced by the last version that worked; checkout SMS codes and caches are shared, so a customer mid-checkout carries on. Problems (disk, database, backups, SMS) are emailed, and a summary of yesterday's orders arrives every morning.
- **Versions, email and a forgotten password.** The version (BUH-xx.xx.xx) shows bottom left on every page; Settings → Versions lists every release with what changed and switches the shop to any of them from 2.0.0 on, the same no-downtime way; Settings → Email & admin account sets the mail server, where backups and alerts go, and your sign-in email; **Forgot password?** emails a one-time link.
- **Status.**
  - **Benchmark:** same host, main vs this branch, two sets of 3 alternating rounds, 0 failed requests in every run. Storefront main 824 / 819 / 855 / 803 / 721 / 890 req/s, branch 681 / 885 / 653 / 796 / 751 / 751 (median about 8% lower; the page now also renders the festival theme, live-update and version pieces). Courier check main 626–728, branch 579–795. Catalogue main 736–837, branch 661–858 (one branch round had a 365 ms p95 that did not repeat; others 139–258 ms vs main's 135–240 ms).
  - **Tests:** 212 passed: unit, end-to-end against the production build, real-browser at 375 px and 1280 px, and the updater against a fake Docker (including the version-switch request channel). CI starts real containers and switches versions under load with zero failed requests.
  - **Dependency audit:** production 0 vulnerabilities (adds firebase 12.19.0, with `@grpc/grpc-js` pinned for Firestore's unused server dependency); the same 5 dev-only ESLint findings as main.
  - **Security scan:** three independent reviews (security, correctness, and one of email, password reset and version switching); every finding fixed with a test or explained in the pull request. No automated scanner is available here.

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
