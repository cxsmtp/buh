# Changelog

## BUH-02.09.00 — 2026-10-18 18:08 UTC · [#25](https://github.com/cxsmtp/buh/pull/25)

- **Confirm on WhatsApp, free.** After ordering, the customer taps one button to send you a prefilled WhatsApp message with the order number and a short code; you compare the number and tap "Confirmed on WhatsApp" in the hub, then "Reply on WhatsApp". You can also hold orders until they are confirmed (off by default).
- **Card, Apple Pay and Google Pay through your Stripe account.** Off until you add your Stripe keys in Settings → Payments; the wallet fills in name, phone, email and address; an order counts as paid only when Stripe confirms the exact amount, and a refund is one tap from the hub.
- **Bank transfer without your account on the website.** Customers who choose bank transfer get your bank details privately: by email straight away, and by a one-tap "Send bank details on WhatsApp" in the hub. Each order has its own private page to upload the transfer screenshot; you tap "Payment received" to confirm it.
- **Audit log keeps order numbers whole.** Order numbers and the person who acted are now recorded exactly in the audit log (some order numbers were partly hidden before); customers' phones and emails stay masked.
- **A shorter top of the shop.** The announcement bar and header stay pinned at the top while scrolling, and the shop's name and logo are no longer repeated, so products start on the first screen.
- **Hub fixes.** The backup card fits a phone, and if anything in the hub ever breaks it now says what went wrong and writes it to the server log.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.08.00) vs the final branch, 5 alternating rounds (3 branch-first, 2 main-first), 0 failed requests. Storefront main 911 / 954 / 820 / 821 / 915 req/s, branch 942 / 885 / 866 / 881 / 896 (p95 102–136 vs 82–152 ms); courier check main 642 / 733 / 681 / 700 / 747, branch 769 / 739 / 701 / 647 / 734; catalogue main 802 / 858 / 850 / 776 / 766, branch 840 / 853 / 720 / 730 / 853 (p95 125–161 vs 135–179 ms). Level: each side is faster in some rounds and slower in others.
  - **Tests:** 580 passed, including bank transfer (no account details anywhere public, private links, uploads, Payment received, emails), the review fixes, the WhatsApp confirmation (unit, routes and browser at 375 and 1280 px), card payments against a stand-in for Stripe (amounts from the server, one payment per order, signed webhooks, replays, refunds, abandoned orders), the pinned bar and the backup card.
  - **Dependency audit:** production 0 vulnerabilities; new packages stripe, @stripe/stripe-js and @stripe/react-stripe-js (pinned).
  - **Security scan:** two independent reviews (card payments and WhatsApp; bank transfer): 3 medium and 5 low payment findings, 2 medium and 5 low bank-transfer findings, all fixed with tests. Apple Pay and Google Pay are not yet tried on a real iPhone or Android.

## BUH-02.08.00 — 2026-10-17 19:36 UTC · [#24](https://github.com/cxsmtp/buh/pull/24)

- **The Admin Hub is off the shop.** The public site has no admin button, tab or address: /admin, /login, /wp-admin and every admin address answer exactly like a page that doesn't exist, byte for byte, so nobody can find it by guessing or scanning.
- **Your own private link.** The hub opens only at a random 32-character link (shown in the log and emailed when it is made). Bookmark it on your phone and laptop: a phone gets the phone view, a laptop the full view, and a switch at the top changes it.
- **Change or recover the link.** Settings → Security → Change the admin link ends the old link on every device at once. Lost it? `podman exec beautifuluaehome node scripts/admin-link.mjs --new` on the server makes a new one; "Forgot password" emails work on a phone that never had the link.
- **Updating keeps you in.** The update makes your link, logs and emails it, and if you are signed in, takes you to it once the next time you open the shop.
- **A hub tab left open says so.** If the link was changed elsewhere, an open hub tab stops at once with "This link no longer opens the Admin Hub", and never counts as a scanner.
- **Scanners are slowed, then shut out.** Behind the shop's proxy, an address asking for many missing pages is slowed and then refused for 10 minutes; shoppers, taken-down products and your own hub never count. Logs (the shop's, Caddy's and nginx's) never hold the link.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.07.00) vs this branch, 3 alternating rounds plus a check round with main first, 0 failed requests. Storefront main 806 / 849 / 803 / 836 req/s, branch 836 / 861 / 855 / 891 (p95 105–124 vs 91–134 ms); courier check main 608 / 709 / 690 / 656, branch 700 / 717 / 704 / 650; catalogue main 787 / 761 / 722 / 775, branch 718 / 850 / 807 / 798. Level; the branch's one slow catalogue tail (p95 257 ms) was its cold first run, and the check round with main first gave 141 vs 154 ms.
  - **Tests:** 492 passed, including the private link at the HTTP server (every admin route, path tricks, byte-identical 404s, headers, rotation, recovery, the reset email, the update), a hub tab left open after the link changed, the scanner store's own cap, and 375 and 1280 px views.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** an independent review of the gate (path tricks, forged doors, timing, headers, logs) found no way in; its 2 medium and 6 low findings were fixed with tests or documented. No automated scanner here.

## BUH-02.07.00 — 2026-10-16 19:35 UTC · [#23](https://github.com/cxsmtp/buh/pull/23)

- **Fits every phone.** Reported: on a phone some screens went past the edge and you had to scroll sideways to reach a ✕. Every screen and pop-up (bag, checkout, confirmation, filter, product, chat, sign-in and the whole Admin Hub) now fits phones from 320 px wide, held sideways and with large text; every ✕ and main button stays in view.
- **A quieter, luxury look.** One palette throughout (warm ivory and linen, deep aubergine-ink text, champagne gold, a dusty-rose accent), an elegant serif for headings with a clean sans for the rest, fine hairlines instead of shadows, and a small "Reduced" mark instead of red SALE badges. Phones always show one large photo per row.
- **Charming festivals.** Each festival now shifts only the accent within the palette (emerald and gold for Eid, saffron for Diwali, berry for Christmas…) with one fine motif and a short, warm greeting; quiet days stay quiet. Settings → Festival themes can preview any of them.
- **A calm announcement bar.** It drifts slowly, pauses when touched, and holds three short lines at most (free delivery in 1–2 days, cash on delivery, handmade in small batches), edited in Settings → Store & contact.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.06.00) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 876 / 875 / 903 req/s, branch 880 / 921 / 946 (p95 133–160 vs 104–143 ms); courier check main 812 / 714 / 807, branch 749 / 721 / 770; catalogue main 859 / 951 / 816, branch 859 / 854 / 838. Level, the storefront slightly faster.
  - **Tests:** 464 passed, including a new check of every screen and pop-up at 320, 360, 375, 390, 412 and 430 px, sideways and at 200% text (10 of 16 cases failed before the fix), the palette (no colour outside it, AA contrast) and every festival look.
  - **Dependency audit:** production 0 vulnerabilities; no new packages (fonts are self-hosted).
  - **Security scan:** no new routes or inputs beyond the three announcement lines (validated on the server); no automated scanner here. Not yet seen on a real iPhone or Android.

## BUH-02.06.00 — 2026-10-16 17:36 UTC · [#21](https://github.com/cxsmtp/buh/pull/21)

- **Manage stock from your phone.** Admin Hub → Inventory: search and filters (low, sold out, hidden), stock per size in colour, big − / + buttons with Undo, a typed number, "Received stock" for several sizes at once, a reason for each change and its history; two phones changing the same item never overwrite each other, and a shaky connection never counts a change twice.
- **Add a product in four steps from the phone.** Take or choose photos, reorder them and pick the cover, then name and price, sizes and stock, and publish; drafts save themselves. Quick actions: hide, sold out, duplicate for a colour variant, share the link. The phone's admin bar puts Orders, Inventory (with a low-stock badge) and Chats first.
- **Big photos on phones.** One large photo per row like Instagram (or two, with the toggle next to Filter), sharp on every screen; tap a photo to zoom with pinch or double-tap.
- **Install the shop as an app.** Customers and you can add it to the home screen: it opens full screen with its own icon, fast on repeat visits, with a calm page when offline; checkout, orders and the Admin Hub are never stored on the phone. A small card offers it once, never during checkout or chat.
- **Faster for shoppers.** The Admin Hub now loads only when you open it, so every customer downloads about 54 KB less.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.05.00) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 823 / 735 / 857 req/s, branch 814 / 872 / 893 (p95 118–180 vs 102–156 ms); courier check main 697 / 706 / 783, branch 746 / 710 / 753; catalogue main 714 / 771 / 884, branch 796 / 869 / 879. Level to faster.
  - **Tests:** 436 passed, including stock moves (no double apply with the same key, conflicts between two devices, audit before done, undo rules), the product editor with photo upload, and the installable app (manifest, icons, offline page, nothing private cached, the emergency off switch) at 375, 412, 768 and 1280 px.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent review of stock moves and the app (8 findings) fixed with tests; not yet tried on a real iPhone or Android install.

## BUH-02.05.00 — 2026-10-16 14:30 UTC · [#11](https://github.com/cxsmtp/buh/pull/11)

- **Browse like Instagram on a phone.** Round collection "stories", a feed of big photos with prices and "Only 2 left", products that open full screen with swipeable photos, a Filter sheet (category, size, colour, price, in stock, on sale) whose choices can be shared as a link, search, and a bottom bar with Home, Search, Bag, Orders and Help.
- **Turn on HTTPS and automatic updates with one line, from the published images only.** The new `buh-updater` sets everything up and keeps the shop, the new `buh-proxy` HTTPS front door and itself up to date; each new version is tried beside the running shop first, and a switch pauses the shop for a few seconds. It works with private images through your saved registry login.
- **Automatic updates can be switched off** in Settings → Versions; updating by hand and restarting a stopped shop still work.
- **Every version is checked.** A version number is published once with fixed fingerprints; your server remembers each version's fingerprint, refuses one that changed, rolls back to the exact one that ran before, and Settings → Versions shows what was installed when, marked verified.
- **Checkout knows every area.** All UAE communities (163 in Dubai) with short names like JVC and JLT, searchable as you type; a rough location from a laptop or phone is saved for the driver but no longer guesses a wrong area.
- **Email settings explain themselves.** A port and security mismatch, a password that isn't saved yet, or a refused login are said in plain words, and failed test emails no longer use up the hourly limit.
- **Fixed:** the product photo counter jumped back when tapping "next" quickly.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.04.00) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 755 / 830 / 804 req/s, branch 788 / 826 / 786; courier check main 663 / 565 / 628, branch 713 / 756 / 626; catalogue main 727 / 794 / 748, branch 818 / 849 / 810. Level. (A first run showed the courier check behind; the area lookup it uses was then made twice as fast.)
  - **Tests:** 371 passed, including real-container tests of setup, switching, the HTTPS proxy and a private registry on Docker, Podman 4.9 and Podman 5.7 (Ubuntu 26.04); the Windows setup line has not run on a real Windows machine.
  - **Dependency audit:** production 0 vulnerabilities; no new packages; base images and CI actions pinned by digest.
  - **Security scan:** two independent reviews of the updater and proxy (7 and 9 findings) and fixes, all with tests; no automated scanner here.

## BUH-02.04.00 — 2026-10-15 23:17 UTC · [#10](https://github.com/cxsmtp/buh/pull/10)

- **Sign in with a passkey.** In Settings → Passkeys & recovery codes you can add your fingerprint, face or PIN (Windows Hello, iPhone, Android) and sign in to the Admin Hub without a password; passkeys need the shop on https:// or http://localhost.
- **Recovery codes if you forget your password.** Create 10 one-time codes, shown once to copy, download or print; each one signs you in once so you can choose a new password, and works even when email is down. You are emailed whenever one is used.
- **Restoring a backup can't bring back an old way in.** Passkeys and recovery codes that come back with an older backup are switched off until you review them, and the Admin Hub reminds you to make new codes.
- **Automatic updates with Podman.** Run `scripts\podman-autoupdate.bat` once: Settings → Versions can then update to the latest or switch to any version, and new versions are installed on a timer. Each new version is tried beside the running shop first; if it doesn't answer, the shop keeps running on the old one. The switch pauses the shop for a few seconds. Your container's settings, port and data volume are kept.
- **You will be asked to sign in once more** after this update (sign-in sessions now survive restores safely).
- **Status.**
  - **Benchmark:** same host, main (BUH-02.03.02) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 842 / 832 / 787 req/s, branch 848 / 834 / 832 (p95 main 148 / 92 / 149 ms, branch 151 / 138 / 142 ms: within main’s own spread); courier check main 718 / 677 / 645, branch 694 / 701 / 716; catalogue main 805 / 779 / 773, branch 820 / 824 / 813. Level.
  - **Tests:** 303 passed, including passkey sign-in with a virtual authenticator and recovery codes at 375 and 1280 px, a code used once even by two copies of the shop at the same moment, restore of passkeys and codes, and the Podman updater against real Docker and Podman containers.
  - **Dependency audit:** production 0 vulnerabilities; new: @simplewebauthn/server 14.0.3, @simplewebauthn/browser 14.0.0.
  - **Security scan:** two independent reviews (sign-in: 6 findings; updater: 7 findings), all fixed with tests; no automated scanner here. The Windows set-up script has not yet run on a real Windows Podman machine.

## BUH-02.03.02 — 2026-10-15 21:13 UTC · [#9](https://github.com/cxsmtp/buh/pull/9)

- **Settings → Versions shows the Podman update.** On a server without automatic updates, the page now gives the two Podman commands (pull `ghcr.io/cxsmtp/buh:latest`, then restart the container in place with its data volume) instead of a Docker Compose command; the Compose one is folded away for the Hostinger setup.
- **Still the old version after updating?** The page says so in plain words: another, older container is still answering (for example on a different port), and `podman ps` shows which one to stop.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.03.01) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 839 / 827 / 810 req/s, branch 831 / 868 / 854 (p95 100–160 vs 95–152 ms); courier check main 664 / 663 / 701, branch 738 / 665 / 676; catalogue main 843 / 819 / 768, branch 820 / 815 / 815. Level.
  - **Tests:** 255 passed; the Versions test now checks for the Podman commands with the real image name (it fails on the previous version).
  - **Dependency audit:** production 0 vulnerabilities; no package changes.
  - **Security scan:** text-only change on an admin page; no new routes or inputs.

## BUH-02.03.01 — 2026-10-15 20:50 UTC · [#8](https://github.com/cxsmtp/buh/pull/8)

- **Podman update command in the README.** One line pulls the newest shop and restarts it in place, keeping your data; it uses the image's real name, `ghcr.io/cxsmtp/buh` (pulling `ghcr.io/cxsmtp/beautifuluaehome` fails with "manifest unknown").
- **Project notes:** containers are run with Podman, and every change is merged to main rather than left on a branch.
- **Status.**
  - **Benchmark:** not run; no shop code changed (notes, README and version number only).
  - **Tests:** full suite in CI on this pull request.
  - **Dependency audit:** no package changes.
  - **Security scan:** not applicable (no code changed).

## BUH-02.03.00 — 2026-10-15 13:41 UTC · [#7](https://github.com/cxsmtp/buh/pull/7)

- **Fixed: text you couldn't read.** On a phone or laptop set to dark mode, labels on the white cards (for example in Settings → Store & contact) turned almost white; the shop now has one look on every device. Every screen (shop, product, bag, checkout, chat, sign-in, every Admin Hub tab and settings section) is measured in light and dark mode at phone and desktop width, and faint gold and grey text was darkened until all of it reads clearly.
- **Settings save themselves.** Each settings section saves about a second and a half after you stop typing, and shows "Saved automatically · Undo"; the Save button is still there. Undo puts back the settings from before your current round of changes.
- **The shop always runs on the last good settings.** Anything invalid is refused and never replaces what works; new mail settings are tried against the mail server first, and if they can't connect while the current ones work, the current ones stay and you're told why. Passwords and keys are only sent when you press Save, and an automatic save never changes an address in a way that would remove its saved key: that waits for Save, with the key.
- **Festival themes:** Hanukkah is no longer included (32 festivals).
- **Status.**
  - **Benchmark:** same host, main (BUH-02.02.00) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 789 / 792 / 761 req/s, branch 856 / 832 / 763; courier check main 687 / 678 / 643, branch 752 / 684 / 698; catalogue main 767 / 837 / 805, branch 816 / 893 / 794. Level.
  - **Tests:** 255 passed, including a readability test of every screen in light and dark mode at 375 and 1280 px (the reported labels measure 1.12:1 on the previous version and pass now), and autosave, refusal of a bad value and Undo in a real browser.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** an independent review of autosave and the settings guard; all 10 findings fixed with tests (no autosave can drop a saved key, a slower save never overwrites a newer one, SMS autosave never switches the gateway on, the logo is uploaded once, Undo returns to the right version and only reloads its own section, the "known working" mark is keyed with the server secret, the test email marks only what it tested, pending changes are sent when leaving a section, hover colours restored). No automated scanner here.

## BUH-02.02.00 — 2026-10-15 11:06 UTC · [#6](https://github.com/cxsmtp/buh/pull/6)

- **Fixed: customers whose device reports a far-away location can order again.** Laptops (and phones on a VPN) often report a network location, e.g. in the USA; checkout turned that into "Corniche, Abu Dhabi", called it accurate, and refused the order as outside the UAE. Delivery is now decided by the address the customer chooses; a location outside the UAE is ignored with a plain message, and inside the UAE it only suggests the nearest area.
- **A simple delivery promise.** Checkout shows a green tick, "We deliver to Al Barsha, Dubai" and "Delivery in 1–2 days, free"; the courier, its hubs and zones are no longer shown to customers (the old "Jeebly API Verified" badge was never a real check: the courier is still booked, and any refusal reported, behind the scenes).
- **Same-day delivery, if you want it.** Switch it on in Settings → Delivery with your charge, the cut-off time (UAE) and the emirates; customers choose it at checkout, the charge is added to their total by the server, and an order placed after the cut-off is moved back to standard before anything is charged.
- **Settings → Delivery.** Choose the emirates you deliver to, list areas you don't serve (whole area names, so "Bay" never blocks Business Bay), and the delivery time customers see.
- **Same-day orders are booked as same day.** They are collected today (UAE date) as Jeebly Express, marked **Same day** in your orders, and can't be booked with Eco Express, which only delivers next day.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.01.00) vs this branch, 3 alternating rounds, 0 failed requests. Storefront main 851 / 837 / 789 req/s, branch 815 / 870 / 772. Courier check main 515 / 767 / 674, branch 587 / 517 / 743. Catalogue main 590 / 794 / 810, branch 821 / 709 / 822. Level within run-to-run spread; the review fixes after it change only checkout, order and settings code, not these pages.
  - **Tests:** 240 passed, including the reported case (a Dubai customer whose laptop reports Virginia), which fails on the previous version and passes now, and real-browser checkout at 375 px with a far-away and a nearby location.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** an independent money and correctness review; all 8 findings fixed with tests (same-day booked for today as Express, whole-name area matching, AED 19.99 charges, no courier name in Track Order, GPS never switches the emirate under a typed area, same day reset when the address changes, a 00:00 cut-off refused, Qatar not taken for the UAE). No automated scanner here.

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
