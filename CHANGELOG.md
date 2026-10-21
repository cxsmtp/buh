# Changelog

## BUH-02.23.01 — 2026-10-21 06:00 UTC · [#43](https://github.com/cxsmtp/buh/pull/43)

- **A clear message when Gemini needs billing.** Google offers its picture models only on paid accounts, so a key on the free tier was refused every time. The shop said "limit reached, wait a minute", which never helped. It now says the key's project needs billing switched on, where to do it (aistudio.google.com → API keys → your project → Set up billing) and the rough cost: about 4 US cents a picture.
- **Status.**
  - **Benchmark:** BENCH_PLACEHOLDER
  - **Tests:** TESTS_PLACEHOLDER
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** one message changed. Google's own error text stays in the scrubbed `detail`, as before (the key is never included).

## BUH-02.23.00 — 2026-10-21 09:00 UTC · [#42](https://github.com/cxsmtp/buh/pull/42)

- **Empty category pages kept out of Google.** Category pages with no products are left out of the sitemap and marked not to be indexed until they have products.
- **A daily summary you can scan.** The 8:00 email now has four sections, one line per item: **Action needed** first (orders to confirm, transfers to check, chats waiting, restocks, problems), then **Sales**, **Inventory** and **System**.
- **Everything in the email itself.** Each order to confirm, transfer to check, flagged order and waiting chat has its own line: order number, customer's first name and initial, amount, payment and how long ago. You can see what needs doing without opening the hub. Full names and phone numbers stay out of the email.
- **More useful sales.** Yesterday's sales now come with the average order, best sellers and the last 7 days compared with the 7 before.
- **Stock by product.** Each sold-out or low product gets its own line with the sizes left (e.g. "Low: Jaipur Jaal Floral — King 2, Super King 1 left"), instead of one long list.
- **A clear subject.** For example "Daily summary 2026-10-20: 3 orders, AED 1,250 · 2 things to do". The email is formatted for phones, with a plain-text copy for mail apps that don't show formatting.
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 848 / 870 / 857 req/s vs main 819 / 853 / 857; catalogue API branch 771 / 772 / 801 vs main 778 / 780 / 787; serviceability API branch 703 / 668 / 694 vs main 698 / 664 / 662; gift page branch 647 / 718 / 699 vs main 703 / 705 / 660. The summary is built once a day; nothing on a shopper's path changed apart from the sitemap check.
  - **Tests:** 1,178 of 1,179 on the full run. The one failure was the palette rule: the email used colours outside the shop's palette. It now uses the palette, and that check and the summary tests pass (29 of 29).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** no new route or stored data. The email is built on the server from the shop's own data; product names are escaped in the HTML. No secrets or private links are in it.

## BUH-02.22.00 — 2026-10-20 23:30 UTC · [#41](https://github.com/cxsmtp/buh/pull/41)

- **Backups follow what happens in the shop.** A new order, payment, stock or price change, product, customer, expense or setting starts a 2-hour clock, and the shop is backed up by then; later changes don't push it back. When nothing has changed there is no backup, no email and no Drive copy. Chat messages and visits ride along with the next backup, or once a day.
- **A weekly check** backs up even a quiet shop once a week, to prove backups still work. It is skipped if a backup already ran that week.
- **Far fewer emails.** By default at most one backup email a day plus the weekly check. Choose every backup, once a day, weekly only or never in Settings → System & backups → When to back up; failure alerts still come at once.
- **History kept by age.** On the server: every backup from the last 24 hours, then one a day for 14 days. On Google Drive: up to 4 a day for a week, one a day for a month, then one a week for 6 months. Ages on Drive are Google's own times, so a wrong server clock can never make copies look old; if the server's clock is more than a day out, nothing is removed anywhere and the status says so.
- **Clearer status.** The status reads, for example, "Last backup 2:10 pm after 14 changes (orders, stock)" and "Next by 4:10 pm, 3 changes waiting", or "Nothing new — none needed". A quiet shop is never shown as failing. You are warned if your newest backups have been only on the server for 2 days (a new shop is not warned at its first backup).
- **Status.**
  - **Benchmark:** 3 alternating rounds (branch first), 0 failed requests. Storefront branch 930 / 893 / 857 req/s vs main 880 / 849 / 849 (p95 137 / 125 / 100 vs 145 / 156 / 124 ms); catalogue API branch 812 / 881 / 820 vs main 832 / 867 / 798; serviceability API branch 751 / 742 / 776 vs main 744 / 709 / 639; gift page branch 769 / 677 / 745 vs main 700 / 707 / 712. Each write now also bumps one small change counter; no slower tail.
  - **Tests:** 1,177 passed, 0 failed, including a server clock a year ahead for 5 backups (Drive and local history kept) and 12 backups a day for 60 days (history spans the promised windows).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** two independent reviews. The first found 1 high (history would shrink to about a day), 3 medium and 2 low issues. The second found that the clock check never fired (high), plus 2 low issues. All are fixed with tests, apart from one documented as a code note: trigger changes need a new migration. Not tried: real Google Drive deletions and real SMTP.

## BUH-02.21.00 — 2026-10-20 23:00 UTC · [#40](https://github.com/cxsmtp/buh/pull/40)

- **Festival gift pages that run themselves.** Each festival has its own page, such as /gifts/diwali, /gifts/eid-al-fitr or /gifts/uae-national-day. Each goes live about 45 days before the festival, with products that have a gift line for it first, and your home page's Google title follows the festival. After the festival the page stays at the same address with next year's dates, so it keeps its ranking.
- **Category pages for searches.** Pages such as /shop/bedsheets are for people searching for bedsheets online in the UAE.
- **Product pages Google understands.** Pages now carry the price in AED, whether each size is in stock, photos and SKU as structured data, with no made-up ratings. Titles, descriptions and photo alt text are written automatically, and the sitemap lists every page.
- **Settings → Search (SEO).** See what Google sees for every page, check the festival schedule (switch a festival off, make it live now, edit its words), edit category pages, and run health checks. There is a place for your Google Search Console and Bing codes, and IndexNow, off by default. Each product can have its own SEO title and description, with a live preview.
- **SKUs made automatically.** New products get a code like BUH-HBS-INDCHV-007 as soon as they have a name. Edit it freely or press Regenerate; codes are never reused and duplicates are refused. "Fill them in" gives the products without a code one; codes they already used on marketplaces are kept for those listings.
- **Status.**
  - **Benchmark:** 3 alternating rounds (branch first), 0 failed requests (main's 1,000 failures per round are the new /gifts/diwali page, which main doesn't have). Gift page 709 / 753 / 746 req/s. Two focused re-runs on a quiet machine, alternating, 4 each, 5,000 requests:
    - **Home page:** branch 696 / 651 / 664 / 674 vs main 677 / 779 / 729 / 722 req/s, p95 about the same (110–120 vs 105–130 ms). The home page is now refreshed every 5 minutes instead of built once, so its Google title and festival banner follow the calendar. Serving it from that cache costs about 8% of throughput, with no slower tail.
    - **/api/products:** the same (branch 770 / 773 / 738 / 746 vs main 765 / 742 / 775 / 771, p95 98–110 vs 98–117 ms).
  - **Tests:** 1,149 passed, 0 failed (unit and end-to-end, including the new SEO, SKU and browser checks at 375 and 1280 px).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent review found 0 high, 2 medium and 2 low issues. Fixed with tests: products without an SKU keep the marketplace code they were exported under; products that already share an SKU can still be saved, and Inventory lists the clashes; gift and category pages refresh after timer changes within a minute. Left as is: made-up page addresses only fill a capped memory cache. Not tried: real Google indexing, Search Console and IndexNow.

## BUH-02.20.00 — 2026-10-20 22:00 UTC · [#39](https://github.com/cxsmtp/buh/pull/39)

- **See and edit the AI writing prompt.** Settings → AI writing → Prompt shows exactly what is sent to Claude, Gemini or DeepSeek. You can edit the shop's instructions and the guide for each part (name, design, comfort…), preview the full prompt, try it on a photo before saving, and reset to the default. The honesty rules stay fixed and are always sent.
- **AI pictures from Gemini, OpenAI or fal.ai.** A new Settings → AI pictures section lets you choose who makes your pictures, each with its own key, a Test button, the model choice and a rough cost per picture. You can keep DeepSeek for writing.
- **Pictures that look like real photographs.** The default now asks for natural window light, real fabric creases, true proportions and realistic UAE rooms. Your scenes (Dubai master bedroom, Palm villa, hotel suite, desert-modern, Eid evening…) can be edited, added and reordered.
- **Make them look like your own photos.** Upload 2–5 style photos and every picture copies their light, colours, camera angle and mood, with your new bed linen in it. Location data is removed from them, and they are kept in backups.
- **Picture studio for every product.** Inventory → Make pictures: pick a photo and scenes, then add the results you like to the product's photos. Without a picture key, it shows the setup steps.
- **Status.**
  - **Benchmark:** 3 alternating rounds (branch first), 0 failed requests. Storefront branch 844 / 898 / 879 req/s vs main 809 / 863 / 858 (p95 87 / 91 / 108 vs 101 / 113 / 102 ms); catalogue API branch 854 / 779 / 767 vs main 787 / 776 / 717; serviceability API branch 669 / 613 / 611 vs main 597 / 579 / 526. Another helper's build was running on the same machine (load average about 5), affecting both builds alike; the new pages are admin-only, and the shop's own pages are unchanged.
  - **Tests:** 1,114 passed, 0 failed (unit and end-to-end, including 11 new browser checks of the prompt editor, AI pictures and Picture studio at 375 and 1280 px).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent review found 0 high, 1 medium and 2 low issues, all fixed with tests. The studio now waits as long as the server, so a picture already paid for is never thrown away. Restoring older AI settings keeps today's picture choices and skips missing style photos. Test keys are built at run time. None of Gemini, OpenAI, fal.ai or DeepSeek has been tried with real keys.

## BUH-02.19.00 — 2026-10-20 18:30 UTC · [#38](https://github.com/cxsmtp/buh/pull/38)

- **DeepSeek for AI writing.** Settings → AI writing now offers DeepSeek beside Claude and Gemini. Paste your key (`sk-…`) and press Test to see your models. `deepseek-flash` reads your product photos; `deepseek-v4-pro` writes text only.
- **Descriptions that help customers choose.** Product copy now has a clear, searchable name, a one-line reason to buy, a design paragraph (with which bedrooms and decor it suits), a comfort paragraph and 3–5 highlights. Nothing is invented: fabric, thread count and sizes appear only from your own notes and the product's sizes.
- **Edit everything before it is used.** Each suggested part has its own box, with Use, Use all, Write again (one part or all) and Keep mine. Nothing changes the product until you press Save.
- **Gift lines that follow the festival.** Each product keeps a gift line per festival (Diwali, Eid, National Day…) plus an everyday one. The shop shows the line for today's festival theme and switches by itself as festivals change. "Write gift lines for the next festivals" prepares the next three at once.
- **Three styled pictures per press.** "Style in a bedroom" makes a whole-bed room shot, a close-up of the print and texture, and a lifestyle scene, each with Add / Again / Discard, plus Add all. Styling still uses Gemini, keeps the product's true colours, and allows up to 30 pictures an hour.
- **No more "0 TC".** A product page leaves out an empty material or thread count instead of showing "0 TC".
- **Status.**
  - **Benchmark:** 3 alternating rounds (branch first), 0 failed requests. Storefront branch 890 / 957 / 933 req/s vs main 911 / 894 / 931 (p95 100 / 126 / 118 vs 83 / 90 / 103 ms); catalogue API branch 820 / 840 / 827 vs main 871 / 726 / 843; serviceability API branch 711 / 763 / 770 vs main 729 / 696 / 757. The storefront's p95 is 15–35 ms higher, at the same or higher throughput: each product now carries today's gift line, worked out once per request.
  - **Tests:** the build's full run gave 1,081 of 1,082 passed. The one failure was a look-switch browser check whose 30-second wait timed out; it passes on its own. The final code's own tests pass (DeepSeek, gift lines and styled pictures: 13 unit and 6 browser checks, plus the spec-line check). The full suite on the final code was still running at merge, and GitHub's checks passed on it.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent review found 0 high, 0 medium and 2 low issues. Fixed: a gift line for a festival a later release renames no longer blocks saving the product. Documented in docs/status.md: going back to an older version while DeepSeek is chosen. DeepSeek and Gemini picture making haven't been tried with real keys yet.

## BUH-02.18.01 — 2026-10-20 14:45 UTC · [#37](https://github.com/cxsmtp/buh/pull/37)

- **No more zooming on iPhones.** Tapping a text box (the chat, checkout, the admin hub) no longer zooms the page and leaves it scrolling sideways. Every text box is now 16px on phones, the size below which iPhone Safari zooms in, so the chat fits the screen with its close button in view.
- **"Book the courier" fits a phone.** Pickup Date has its own row and Weight and Parcels sit side by side, so nothing spills out of its box.
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 873 / 893 / 920 req/s vs main 902 / 927 / 945 (p95 108 / 102 / 119 vs 153 / 106 / 86 ms); catalogue API branch 825 / 850 / 781 vs main 830 / 803 / 845; serviceability API branch 707 / 695 / 798 vs main 659 / 705 / 738. One CSS rule and one dialog's layout changed, nothing on the server, so these differences are noise.
  - **Tests:** 1,064 passed, 0 failed (unit and end-to-end, including the 2 new phone checks).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** no server, route or data change. Two new browser checks fail before the fix and pass after: the chat box text was 14px, and the date box was 98px wide. Real iPhone Safari wasn't available; the checks test the 16px rule and box widths behind the zoom.

## BUH-02.18.00 — 2026-10-19 21:40 UTC · [#36](https://github.com/cxsmtp/buh/pull/36)

- **Backup password, set in the hub.** Settings → System & backups → "Protect backups with a password". Press "Make one for me" (six words and two digits), copy or download it, tick "I saved it", or type your own. No server settings needed.
- **Change it any time.** Changing it asks for your hub password, and the card lists earlier passwords by date, because backups made before a change still open with the old one. The restore tool names the day of the password a backup needs.
- **Google Drive in four guided steps.** "Set up Google Drive" opens each Google page for you, with Copy buttons for every value. You then upload the file Google gives you and enter one large code at google.com/device. The hub shows "Connected to <your Gmail>" and makes the first copy at once.
- **Drive waits for the password.** If Drive is linked before a password exists, copies start by themselves as soon as you set one.
- **Never unencrypted by accident.** If the password file is ever damaged, backups stop and the hub shows a red alert, instead of sending customers' details unencrypted.
- **Status.**
  - **Benchmark:** 3 alternating rounds (branch first), 0 failed requests. Storefront branch 757 / 743 / 738 req/s vs main 675 / 730 / 754; catalogue API branch 692 / 661 / 702 vs main 733 / 643 / 704; serviceability API branch 568 / 570 / 633 vs main 602 / 580 / 611. The branch's first storefront round (p95 171 ms) was the cold start; rounds 2–3 match main (p95 110 / 102 vs 104 / 112 ms). No page or hot path changed.
  - **Tests:** 1,064 tests (unit and end-to-end, including 375 and 1280 px browser checks). Two full runs gave 1,063 and 1,062 passed: each time one or two different browser checks timed out while the machine was heavily loaded (load average 15). Those files pass on their own (password reset and expense bills, 23 of 23); neither area changed in this release.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent review found 0 high, 2 medium and 3 low issues. Fixed with tests: "I saved it" now saves only the password on screen, a damaged password file stops backups, a race between two first-time saves, and log masking that stopped after 100 passwords. Not changed: the password fingerprint uses a fixed salt (no faster to guess than the backup itself; one shop). Google Drive has not been tried with a real Google account yet.

## BUH-02.17.00 — 2026-10-19 21:00 UTC · [#35](https://github.com/cxsmtp/buh/pull/35)

- **Read-only access for your accountant.** Invite them from Settings → Security. They see only Money (reports, expenses with bills, VAT and the audit log) and can change nothing. Removing access, or "sign out everywhere", ends their access at once, and restoring a backup never brings it back.
- **UAE VAT when you register (off until then).** Enter your TRN and a start date, and from that date orders carry 5% VAT. Tax invoices are numbered with no gaps, credit notes follow refunds, and Money → VAT gives the quarterly return for your accountant. Reports show figures with and without VAT.
- **Backups copied to your Google Drive.** Use "Connect my Google Drive" with a code at google.com/device. Copies are always encrypted, only the shop's own copies are kept (newest 30), and a new server can be rebuilt from Drive with one line.
- **Share a selection.** Tick products in Inventory, name it (e.g. "Eid picks") and share one link with a proper WhatsApp/Instagram preview, with an optional end date.
- **More than bedding.** Towels, cushions, throws and curtains get simple sizes, prices, stock and weights, without bed measurements.
- **Amazon.ae / Noon starter export** and a **hub that opens where you need it** (today's orders on your phone, the overview on a laptop).
- **Safer edges.**
  - Gemini's new "AQ." keys are accepted and hidden everywhere.
  - The Stripe webhook address now looks like any unknown page to anything that isn't a signed Stripe delivery, and future-dated deliveries are refused.
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 786 / 758 / 632 req/s vs main 759 / 696 / 711; catalogue API branch 691 / 647 / 583 vs main 735 / 612 / 687; serviceability API branch 582 / 556 / 560 vs main 595 / 553 / 587. The branch's slower third round coincided with another build on the same machine (load average up to 3.5). Focused re-runs, alternating, 4 each, show the same speed: serviceability branch 667 / 641 / 627 / 659 vs main 610 / 650 / 651 / 636; catalogue branch 631 / 658 / 654 / 649 vs main 629 / 627 / 644 / 674.
  - **Tests:** 1,042 passed, 0 failed (unit and end-to-end).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** independent reviews of the accountant and VAT work, the catalogue features and the Drive backups found 0 high, 4 medium and about 30 low issues, all fixed, mostly with tests that fail before and pass after. Google Drive has not been tried with a real Google account yet.

## BUH-02.16.00 — 2026-10-19 09:30 UTC · [#34](https://github.com/cxsmtp/buh/pull/34)

- **Style in a bedroom (Gemini).** In the product editor, Gemini places your bedding in a styled bedroom (Dubai luxury master, Palm villa, Hotel suite, Clean catalogue, Kids' room) from a plain camera photo. You see the original and the result side by side and choose Add, Try again or Discard, and your real photo is never replaced.
- **Honest about styled photos.** Styled photos show a small "Styled image" tag in the shop (on by default) and keep Gemini's AI-made marker for Google and Meta. They stay out of the product feed when the tag is off. The old fake "AI staging" that showed stock pictures is gone.
- **Gemini for writing too.** Settings → AI writing lets you pick Claude or Gemini, and Test lists the models your key can use.
- **Four bright looks.** Jumeirah Azure, Civic Gold, Digital Skyline and Palm Fresh, each with a dark version, in Settings → Look. Ivory & Gold stays the default.
- **3.5% card payment fee.** When a customer pays by card, a "Card payment fee" line is added before the total, worked out on the shop's server; Stripe charges it, refunds include it, and reports show it as "Card fees". Change it or set 0 in Settings → Payments.
- **Bank transfer on request.** Bank transfer can be offered without putting your account on the website. The customer taps "Confirm & ask for bank details on WhatsApp" after ordering, and you reply from the hub with one tap.
- **Beautiful Home Assistant.** The chat assistant has a new name; a name you chose yourself is kept.
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 705 / 714 / 747 req/s vs main 759 / 748 / 720; catalogue API branch 602 / 694 / 661 vs main 752 / 652 / 694; serviceability API branch 553 / 554 / 566 vs main 616 / 556 / 539. Focused re-runs, alternating, 4 each: serviceability (5,000 requests) branch 664 / 667 / 585 / 677 vs main 665 / 670 / 632 / 649; catalogue (4,000) branch 656 / 594 / 647 / 622 vs main 614 / 608 / 663 / 656, the same within noise. The host ran slower overall this time, for both builds.
  - **Tests:** 922 passed, 0 failed (unit and end-to-end).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** two independent reviews (payments; Gemini), 0 high. 4 medium and 12 low findings fixed, each with a test that fails before and passes after. Gemini has not been tried with a real key yet.

## BUH-02.15.00 — 2026-10-19 06:10 UTC · [#33](https://github.com/cxsmtp/buh/pull/33)

- **Write name & descriptions from a photo.** In the product editor's Photos step, one tap reads the design in your photo (pattern, motif, colours, texture) and fills in the name, short description and full description. It never invents thread count, material, origin or care claims, and nothing is saved until you publish.
- **Your text stays yours.** If you've already written something, you see both versions side by side with "Use these" or "Keep mine". Suggested colours and weave are added only when you tap them.
- **Settings → AI writing.** Add your Anthropic key and choose the model (Claude Opus 5.5 is recommended; Sonnet 5.5 and Haiku 5.5 cost less). Test checks the key. The key stays on the shop's server, isn't kept in backups and never appears in logs.
- **Weaves you can change.** Settings → Catalogue has a Weaves list: add, rename, reorder and remove. Renaming updates every product that uses the weave in one go, and a weave still in use can't be removed (the shop names the products).
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 856 / 891 / 909 req/s vs main 961 / 864 / 858; serviceability API branch 734 / 707 / 661 vs main 742 / 699 / 740. The catalogue API was mixed in the short run (branch 796 / 717 / 865 vs main 955 / 789 / 850), so it was re-run on its own, 4 × 4,000 requests each, alternating: branch 781 / 820 / 793 / 772 vs main 774 / 776 / 759 / 743 req/s, the same or faster. Serviceability, re-run the same way: branch 806 / 830 / 755 / 787 vs main 714 / 772 / 813 / 810.
  - **Tests:** 832 in the full run. 2 AI-settings browser checks failed on a test expectation edited by mistake (the test saves Sonnet earlier on purpose). After the fix that file passes 7/7.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** the new owner routes (describe, AI test, weaves) check the session, cap and allow-list their input, rate-limit and audit. The only new outbound address is the fixed `https://api.anthropic.com/v1/messages`, through `safeFetch`. Not yet tried against Anthropic's real service: that needs the owner's key.

## BUH-02.14.00 — 2026-10-19 08:40 UTC · [#32](https://github.com/cxsmtp/buh/pull/32)

- **Real Jeebly bookings.** Booking a courier now uses Jeebly's own API, exactly as documented and tested against Jeebly's demo system (create, label, tracking and cancel all passed). Before, the key labels and every booking field were wrong, so nothing ever reached Jeebly.
- **Test first, then Live.** Test mode books in Jeebly's demo system with separate test keys. Live mode needs Jeebly's live address and a Sandbox check passed in the last 30 days. Every screen says plainly which mode is on, and test bookings never reach customers.
- **Real labels.** "Print Jeebly label (PDF)" prints Jeebly's own label. The shop's packing slip has real, scannable barcodes, your own pickup details and the real contents, and test bookings are marked TEST.
- **Live tracking.** Track Order shows Jeebly's latest status and events to the customer (no phone numbers, rider or proof photos). The hub has Refresh tracking, and cancelling an order also cancels its Jeebly booking.
- **Enter tracking number.** A parcel booked in a courier's own portal can be given its tracking number on the order, and the customer sees it straight away.
- **Weight per size.** Each size can carry its packed weight. The booking weight is worked out from the order plus packaging (200 g, changeable) and rounded up to whole kilos for Jeebly; a size with no weight is pointed out, never guessed.
- **No invented details.** Made-up warehouse addresses, phone numbers, hubs and sample accounts are gone from bookings, labels and messages, and Eco Express no longer books against a demo server.
- **Already in Live mode?** Add Jeebly's live address in Couriers; bookings wait for it.
- **Status.**
  - **Benchmark:** 3 alternating rounds (main first), 0 failed requests. Storefront branch 839 / 909 / 805 req/s vs main 814 / 778 / 889; catalogue API branch 817 / 806 / 848 vs main 795 / 803 / 806. The serviceability API was mixed in the short 1,000-request run (branch 556 / 734 / 614 vs main 804 / 655 / 637), so it was re-run on its own: 4 × 5,000 requests each, alternating, gave branch 799 / 835 / 781 / 820 vs main 773 / 827 / 854 / 817 req/s (p95 88–98 vs 90–96 ms), the same within noise.
  - **Tests:** 805 of 806 passed in the full run. The card-payment browser check at 375 px timed out waiting for the homepage under load, then passed 10/10 twice on its own. The security review's 13 findings were fixed, each with a test that fails before and passes after.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** new admin routes (carrier label, carrier tracking, enter tracking number, Sandbox check, Live switch) check the session, size-cap and allow-list their input, and are audited. Carrier keys stay on the server and are blanked in backups. Real run against Jeebly's demo: create, label PDF, tracking and cancel passed (test AWBs JB115105, JB115106, both cancelled).

## BUH-02.13.00 — 2026-10-19 03:50 UTC · [#30](https://github.com/cxsmtp/buh/pull/30)

- **Newer, slimmer server software.** The shop now runs on Node 24 (Node 20 is out of support), and npm, yarn and corepack are removed from the running shop, which only needs `node`. This clears the known holes Checkmarx found in the old base image.
- **Updater and HTTPS proxy refreshed.** The updater carries only the container command it uses (docker CLI 29.9.1 on Alpine 3.24), and the proxy is Caddy 2.11.7 without curl. Both now report their own health.
- **No sample courier keys in the hub.** Leftover example Jeebly and Eco Express keys were removed from the Admin Hub's page code.
- **Safer receipt links.** Links to bank-transfer receipts open only this shop's own pages or http(s) addresses, the same on the server and in the browser.
- **Stripe webhook address shown safely.** Settings → Payments only builds the webhook address from a plain host name, otherwise it shows "your-domain".
- **Status.**
  - **Benchmark:** 3 alternating rounds, 0 failed requests. Storefront branch 915 / 839 / 908 req/s vs main 838 / 940 / 943; serviceability API branch 681 / 619 / 718 vs main 717 / 761 / 791; catalogue API branch 819 / 803 / 778 vs main 805 / 833 / 874. No code on these paths changed. The branch's slightly slower rounds coincided with another build and test run on the same machine (load average up to 6.9), so they are noise.
  - **Tests:** 740 passed, 0 failed (unit and end-to-end, Node 22). Node 24, the image's version, was checked separately (698 of 698 before the latest merges).
  - **Dependency audit:** production 0 vulnerabilities; dev-only `debug` raised to 4.4.3.
  - **Security scan:** Checkmarx Fusion Hub scan 6324d8fd (329 findings) triaged: images, the sample keys and 2 code findings fixed, with 8 new tests that fail before and pass after. The remaining ones are test fixtures, by-design behaviour or dev tools with no fixed version, listed for marking Not exploitable. The rescan follows the merge.

## BUH-02.12.00 — 2026-10-19 03:08 UTC · [#29](https://github.com/cxsmtp/buh/pull/29)

- **Four luxury looks, each light and dark.** Settings → Look: Ivory & Gold (today's look, unchanged in light), Noir & Champagne, Pearl & Emerald and Sand & Rose, each with a matching dark version.
- **Follows each customer's device.** A phone or laptop in dark mode sees the dark version of your look, in the shop and in your hub; you can also choose "Always light" or "Always dark".
- **Switch back any time.** Every change is kept with its date, time and who made it; "Earlier looks" has a Switch back for each, and the look before themes is always there.
- **Festivals untouched.** Festival dates and settings are as they were; the festival colour sits on top of every look and stays readable in dark mode.
- **Every screen follows the look,** including checkout's card fields, the bank-transfer page, the WhatsApp panels, Money and Settings.
- **Status.**
  - **Benchmark:** 3 alternating rounds, 0 failed requests. Storefront branch 769 / 866 / 849 req/s vs main 957 / 779 / 675 (p95 111–123 vs 114–171 ms); serviceability API branch 633 / 695 / 679 vs main 643 / 655 / 572; catalogue API branch 782 / 838 / 894 vs main 800 / 814 / 595.
  - **Tests:** 732 passed, 0 failed (unit and end-to-end).
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** the new owner route (/api/admin/look) follows the hub's checks (door, session, same site, allow-list); /look.css serves only colours. Readability checked for every look, light and dark, on every screen at 375 and 1280 px.

## BUH-02.11.00 — 2026-10-18 22:44 UTC · [#28](https://github.com/cxsmtp/buh/pull/28)

- **Expenses with photos of bills.** Admin Hub → Money → Expenses: add an expense from your phone with a photo or PDF of the bill (date, amount, category, who you paid, how). Nothing is ever silently deleted or overwritten: edits keep every version and a removed expense stays on record with who removed it and why.
- **Reports for your accountant in one place.** Money → Reports: any month, quarter, financial year or dates — sales, refunds (on the date they happened), expenses by category, profit, payment methods — and one ZIP for your CA with Excel-ready sheets, a printable summary, every bill photo and the audit log for the period.
- **VAT watch.** Your 12-month sales against the AED 375,000 registration threshold, with a warning at 80%; VAT itself stays off.
- **Audit log you can read.** Money → Audit log: every order, payment, refund, stock, product, settings, sign-in and expense change, searchable, with a check that the log hasn't been tampered with (it stays correct after moving to a new server).
- **Everything that moves money or stock is recorded first.** Order changes, product prices and refunds are written to the audit log, before and after, before they count; each refund has its own dated record.
- **Safer backups.** Backups and the accountant's ZIP are written as a stream, so large bill folders never slow the shop or make a backup too big to restore; you're warned well before any limit.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.10.00) vs this branch, 3 alternating rounds plus 2 with main first, nothing else running, 0 failed requests. Storefront main 895 / 883 / 901 req/s, branch 880 / 921 / 921 (p95 91–114 vs 89–142 ms; the 142 was the branch's cold first run); courier check main 733 / 722 / 769 / 760 / 734, branch 745 / 696 / 735 / 729 / 764 (p95 79–91 vs 77–101 ms, crossing over between rounds); catalogue main 901 / 786 / 849, branch 835 / 839 / 934. Level.
  - **Tests:** 690 passed, including expenses, bills, reports and the accountant's ZIP, the refunds ledger, audit key ids and gaps, large streamed backups and restores, and the money screens at 375 and 1280 px.
  - **Dependency audit:** production 0 vulnerabilities; no new packages (the ZIP writer is the shop's own).
  - **Security scan:** an independent review (6 medium, 5 low findings: refund dates, more than 2,000 expenses, audit checks after a server move, backup size, export load, bill file checks), all fixed with tests that fail before and pass after.

## BUH-02.10.00 — 2026-10-18 22:17 UTC · [#27](https://github.com/cxsmtp/buh/pull/27)

- **Customers confirm on WhatsApp, free: no SMS code.** Checkout asks only for the mobile number; the customer confirms by sending you one WhatsApp message. Settings → Phone check keeps the SMS-code options for later (off).
- **Unconfirmed orders sort themselves out.** They show "Awaiting WhatsApp — auto-cancels in 13 h" in the hub and are cancelled (stock back) after 24 h, or after 6 h if the customer never opened WhatsApp; both times are yours to change. Bank transfers are never cancelled: they're flagged for you to check your bank.
- **One tap for every case.** "Ask to confirm" opens WhatsApp to the customer; "Confirmed by phone call" for customers without WhatsApp; "Use the number it came from" and "Correct the phone number" when the number differs. Shipping an unconfirmed order asks you first and is recorded.
- **Fake orders can't hold your stock.** Unconfirmed orders take at most 2 of each piece and 5 lines, hold at most half of any size's stock, and are limited per number and per connection; you're alerted if they pile up.
- **Measurements are your own.** Each size shows only what you filled in (flat or fitted sheet, pillowcases, duvet cover, other pieces) — no more duvet cover on sets that don't have one. A "Fitted sheet (elastic corners)" tick; "Use standard sizes" fills the fields in one tap; existing products get a "Check measurements" badge to review once.
- **Colours only when you add them.** No colours means no colour choice; one colour shows as a label.
- **Status.**
  - **Benchmark:** same host, main (BUH-02.09.01) vs this branch, 3 alternating rounds, nothing else running, 0 failed requests. Storefront main 921 / 899 / 894 req/s, branch 931 / 959 / 966 (p95 85–98 vs 78–95 ms); courier check main 748 / 768 / 720, branch 762 / 713 / 685; catalogue main 843 / 835 / 840, branch 920 / 873 / 850 (p95 134–144 vs 131–137 ms). Level; the storefront slightly faster.
  - **Tests:** 630 of 631 passed in the full run; the one failure was a page that took over 30 s to load while every browser test ran at once, and its file passed 6 of 6 on its own.
  - **Dependency audit:** production 0 vulnerabilities; no new packages.
  - **Security scan:** an independent review (1 high, 4 medium, 5 low findings in the phone check and measurements carry-over), all fixed with tests that fail before and pass after.

## BUH-02.09.01 — 2026-10-18 20:17 UTC · [#26](https://github.com/cxsmtp/buh/pull/26)

- **Chats open again in the Admin Hub.** Reported: tapping a chat showed "Something went wrong… i is not a function". Newer Chrome on phones answers a scroll request in a way the chat screen didn't expect; the screen now ignores that answer, and a test plays that newer Chrome to keep it fixed.
- **Track Order fits again.** Reported: the box's title bar covered the order-number field; the fields now start clearly below it, on phones and laptops, before and after a search.
- **Status.**
  - **Benchmark:** not run: two small screen fixes (the hub's chat screen, the Track Order box), no server code changed.
  - **Tests:** 582 passed (4 browser tests timed out while other builds loaded the machine and passed when rerun; one card-payment browser test now waits for the screen to redraw), including the new chat test (fails before the fix, passes after) and a check that no screen in the shop or hub has the same pattern.
  - **Dependency audit:** production 0 vulnerabilities; no package changes.
  - **Security scan:** not applicable (no new input, route or data).

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
