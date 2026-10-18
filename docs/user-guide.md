# User guide

## For customers: browsing the shop

The shop looks and works like a boutique's Instagram page, on a phone first: quiet, with a lot of air, the photographs first, and one palette throughout (see **The look** below).

- **The announcement bar** at the very top: up to three short lines (Settings → Store & contact). It drifts slowly, stops while a finger, the pointer or the keyboard is on it, and stays still in the middle when its lines fit or there is only one. On a phone set to reduce motion it never moves (on a phone it then shows just the first line).

- **At the top:** the shop's logo, name, tagline and address (Settings → Branding & bank, Store & contact), how delivery and payment work, and the festival greeting when one is on.
- **Round story chips:** **All**, **New in** and **On sale** (each only when it shows fewer pieces than All), then one per category, in the order of Settings → Catalogue, each with a photo from inside it. A category with no pieces in the shop has no chip. One tap shows just that.
- **The feed:** on a phone, always one large photo per row, edge to edge, like a boutique's own feed (the two-across grid looked cramped, so it is gone). Tablets show two (upright) or three (sideways) across, a computer four. Each piece has the name, the price (and, when it is reduced, the price before crossed out with a small **Reduced** mark: no red SALE badges) and **Only 1 left** or **Sold out** from the real stock.
- **Tap a photo** and the product opens full screen: swipe the photos (or use the arrows, the dots or the arrow keys); tap a photo again (or the expand button) to see it full screen and pinch, double-tap or use **+** / **−** to look at the print up close (Back or ✕ closes it). Choose the size and colour, **Add to Bag**, or **Ask in chat / on WhatsApp / on Instagram**. **Share** sends its link. The phone's Back button closes it.
- **Filter** (next to the number of pieces) opens a sheet with only the choices that make a difference for the pieces in the shop: category, size, colour (worked out from each colour's swatch: blue, cream, red…), price range, **In stock only**, **On sale**, **New in**, and the sort (newest, price). Each choice shows how many pieces it leaves; **Show N pieces** applies them. Every filter on shows as a chip under the button: tap it to remove it, or **Clear all**.
- **Search** (the tab bar on a phone, the magnifier on a computer) finds pieces by name, colour, category or fabric as you type; tap one to open it, or **See all** to show them in the shop.
- **Links keep the view:** the address holds the search, filters and the open product, so a filtered view can be sent on WhatsApp and Back steps through what you looked at.
- **On a phone** the tab bar at the bottom has **Home** (back to the top), **Search**, **Bag** and **Orders** (Track Order), with the **Help** button (chat, or WhatsApp) in its right-hand slot, so nothing floats over the products; the version number is at the very bottom of the page.
- **Every phone:** the shop fits screens from 320 px wide (small Androids) to large phones, upright or sideways, and with the phone's text set to its largest: nothing needs sideways scrolling. Every sheet (product, bag, checkout, filters, search, chat, order tracking, sign-in) keeps its title and **✕** at the top and its main button (Add to Bag, Proceed to Checkout, Place order, Show N pieces) at the bottom, above the keyboard and the home bar.
- Everything works with the keyboard (Tab, Enter, Escape closes a sheet), and the shop moves less for people whose phone is set to reduce motion.

### The look

One palette, defined once and used by every page, the Admin Hub, the offline page, the app icon and the phone's status bar:

| Token | Colour | Used for |
| --- | --- | --- |
| ivory | #faf6ef | the page, like undyed linen |
| surface | #fffdf9 | sheets and cards |
| sand / sand-deep | #f2ebdf / #e8decd | soft panels, photo placeholders |
| ink | #2b2127 | text and the main buttons: a deep aubergine-charcoal, warmer than black |
| ink-soft / ink-muted | #5a4c53 / #6a5c62 | secondary text |
| gold | #c2a36b | champagne gold: rings, hairlines, ornaments, text on ink |
| gold-deep | #82612c | antique gold for gold text on light backgrounds |
| rose (soft, deep) | #c49a98 (#f4e8e5, #8a5659) | the quiet secondary: the Reduced mark, festive touches |
| success, warning, danger | #3d6a4e, #85601c, #9a3e39 | sage, ochre and brick, each with a soft tint and a line |
| line / line-strong | #e5dac9 / #cbbba3 | hairline borders and dividers |

Headings are set in **Cormorant Garamond** (an elegant serif) and everything else in **Inter**; both are served by the shop itself. Labels are small spaced capitals; borders are hairlines rather than shadows; corners are the same everywhere. Every text colour reaches the WCAG AA contrast the tests check.


## Install the shop as an app

The shop can sit on the home screen of a phone or tablet and open full screen, without the browser's address bar, like an app from a store (it takes almost no space, and there is nothing to update: it is always the latest shop).

**For customers**

- **Android (Chrome, Samsung Internet, Edge):** after a few seconds in the shop a small card offers **Install the app**; tap **Install**. Or open the browser's menu (⋮) → **Install app** / **Add to Home screen**.
- **iPhone and iPad (Safari):** the card says how: tap **Share** (the square with the arrow), then **Add to Home Screen**. In Chrome or another app's browser on an iPhone, open the shop in Safari first.
- The card shows once per phone and never while something is open (a product, the bag, checkout). **Not now** or ✕ closes it for good.
- Long-press the icon for shortcuts straight to the **Bag** and **Track Order**.
- **No connection?** The app shows a calm "You are offline" page instead of an error; the bag is kept on the phone, and the shop opens again by itself when the connection is back. Prices, stock and orders always come from the shop live, never from an old copy.
- **A new version:** a line at the top says **New version ready — Refresh**. Tap it (the bag is kept), or it switches the next time the app is opened. It never switches in the middle of a checkout.

**For the owner**

- The app's name and icon come from **Settings → Branding & bank**: the store name (a name in capitals shows as "Beautiful UAE Home"; the label under the icon is shortened to fit, e.g. "UAE Home") and the logo (a PNG or JPEG logo on white, or the logo's letters on the brand colour). A new logo reaches installed phones when they next check, usually within a day.
- During a festival the phone's status bar takes the deep shade of the festival's accent; otherwise the shop's ink.
- Installing needs the shop on **https://** (the deployment's Caddy gives it). Install it on your own phone the same way. The Admin Hub is not in the shop's app: add your admin link to the home screen separately (see "Your private admin link").
- What the app keeps on the phone, and what it never keeps: docs/security.md, "The installed app".
- **If the app misbehaves on phones** (an emergency): set `SW_RESET=true` in the shop's settings and restart the shop. Each phone that opens the shop then drops the app's saved copy and works as a plain website (the icon stays; it opens the website). For a phone that is still stuck, open `https://yourdomain/reset-app` on it: it also clears that phone's bag. When things are fixed, set `SW_RESET=false` (or remove it) and restart: phones pick the app up again on their next visit.
- **Going back to a version from before the app** (BUH-02.05.00 or older) is safe: the shop works as a website at once, and the app's saved copy removes itself from each phone the next time the shop is opened (within about 10 minutes).

## For customers: placing an order

1. Choose a set, a bed size and a colour, then **Add to Bag** and **Proceed to Checkout**.
2. **Your UAE mobile.** Type the number (50 123 4567, 050…, +971… all work). Checkout says **We confirm orders over WhatsApp.** and sends no code (Settings → Phone check "WhatsApp (free)", the default): the WhatsApp message after ordering is the confirmation (step 4). Only UAE mobiles (50, 52, 54, 55, 56, 58) are taken.
   - **When the shop uses SMS codes** (Settings → Phone check "SMS code"): tap **Send code** and enter the 6-digit code from the SMS; it is checked as soon as the sixth digit is in. Pasting the code or using the phone's autofill works too.
   - The code is valid for 10 minutes, and a new one can be requested after 30 seconds.
   - After 5 wrong tries the code stops working; request a new one.
   - **Outside the UAE?** As soon as a non-UAE number is typed, checkout shows **Email orders@…**, which opens an email with the bag already listed.
   - **SMS not arriving?** If the shop's SMS service is down, checkout says so and offers the shop's email.
3. Fill in the delivery address (or **Use My GPS**), choose Cash on Delivery or bank transfer, and **Place order**. The button stays locked until a UAE mobile is typed (with SMS codes: until it is verified).
   - **Paying by bank transfer:** the shop's bank account is never shown on the website. After you order, you get it privately:
     - by email (if you gave one): "Bank details for your order BUH-…", with the amount, the reference to use (your order number) and your order's private link; you can also just reply to that email with your screenshot;
     - on WhatsApp: the **Confirm on WhatsApp** message also asks for the bank details, and the shop replies with them;
     - on your order's private page: the confirmation screen's **Upload your transfer screenshot** opens it (Track Order shows the same button). It has the account (with **Copy** buttons), the amount and the reference, and an upload for a screenshot or PDF of the transfer (up to 5 MB). After uploading: "Thank you, we'll confirm your order once we see the transfer." Uploading again replaces it. The page works until the order is paid or cancelled, or for 14 days; please don't share its link.
   - **Paying by card** (when the shop has switched it on): choose **Card**, type the card in Stripe's secure field and tap **Pay AED …**. No SMS code is needed (paying is the proof), but the UAE mobile is still asked for the courier. A bank's own check (3-D Secure) opens on the same page.
   - **Apple Pay / Google Pay** (top of checkout, on an iPhone or Mac with Safari, or Chrome on Android or a computer): one tap pays and fills in your name, email, phone and delivery address. If the shop can't tell your area from the wallet's address, checkout fills in the rest, asks you to choose the area and tap the button again; nothing is charged until then. The phone must be a UAE mobile (if the wallet's isn't, type one in checkout).
   - The confirmation says **Payment is being confirmed…** until Stripe has told the shop, then **Paid by card · Apple Pay · Visa •••• 4242** (usually within seconds). A declined card is not charged and nothing is kept: try another card or choose cash on delivery.
4. **Confirm on WhatsApp.** The confirmation screen shows a large green **Confirm on WhatsApp** button: "To confirm your order, tap to send us a WhatsApp message. Orders not confirmed within 24 hours are cancelled." (the shop's hours). Tap it: WhatsApp opens with "Confirm my order BUH-… · code 1234" to the shop already typed; tap **Send**. That message, from your own WhatsApp, shows the shop the number is yours. The same button is in **Track Order** and in the bank-details email until the shop has confirmed it. With SMS codes the step is optional ("Your order is placed either way", unless the shop holds orders until the message comes). If the shop has no WhatsApp number set, the screen says the shop will call you to confirm.
5. **Track Order:** enter the order number (shown on the confirmation and pre-filled on the same phone) and the mobile number used for the order.
- **Picking up where you left off.** The bag and your delivery details are kept on your phone (**Not you? Clear them** at checkout forgets the details). **Save or send this bag as a link** carries it to another browser, e.g. from Instagram's built-in browser to Safari or Chrome.
- **Most designs are one or two pieces.** A size shows **Only 1 left** or **Sold out**; you can't add more than there are, and a sold-out size offers **Ask us** (WhatsApp or email) instead.
- Prices are in AED. Visitors outside the UAE also see an approximate price in their own currency; you always pay in AED.
- Stock and prices update on the open page within seconds. Prices and stock are always checked by the shop when the order is placed.
- **Share** on a product sends its link (with its photo in the preview) through WhatsApp or the phone's share sheet.

- **Delivery** is free, in 1–2 days, to all seven emirates; a green tick confirms the address. Where the shop offers it, **Same day** can be chosen for an extra charge before the cut-off time. **Use My GPS** always saves the location for the driver, but only fills in the area when the reading is precise (within 300 m) and next to a community it knows; a laptop or phone indoors often gives an approximate Wi-Fi location (± 1–5 km), and then it says so and you choose the area. A location outside the UAE (common with VPNs) is not used. **Area** suggests communities from every emirate as you type any part of the name or a short form ("JVC", "JLT", "DIP"); choosing one in another emirate switches the emirate, and you can still type any area. **Drop Pin on Map** is a searchable list of communities whose location is known.

## For the owner: the Admin Hub

### Your private admin link

The Admin Hub is not on the shop's pages: there is no button, tab or link to it, and addresses like /admin, /login or /wp-admin are an ordinary "page not found", exactly like any address that does not exist. It is only at your own private link, which looks like `https://yourdomain.ae/k7Qm2vXa9pTeLr4w…` (32 random letters and digits).

- **Where to find it:** the first start prints it in the log, in a box next to the first password (`podman logs beautifuluaehome`). It stays in that container log until the container is removed, so keep the server's login private. When email is set up it is also emailed to your admin email.
- **Updating from an earlier version:** the update makes your link. It is printed once in the log and emailed (when email is set up), and if you are signed in at that moment, the next time you open the shop you are taken to it once. The Admin Hub then says **The Admin Hub has moved to this private link**.
- **Bookmark it on your phone:** open the link, then on an iPhone Share → **Add to Home Screen** (or Add Bookmark); on Android the ⋮ menu → **Add to Home screen** (or the bookmark star). **On your laptop:** open it and press Ctrl+D (⌘+D on a Mac). The hub says "This is your private Admin Hub link" until you press **I've bookmarked it**.
- **One link for every device:** a phone gets the phone view (one column, the tab bar at the bottom), a laptop the full view (tabs at the top). The **Phone view / Laptop view** switch at the top changes it; each device remembers its choice.
- **Keep it private:** don't share or post it. Opening it lets a browser reach the sign-in for 30 days (renewed while you use it); your password, a passkey or a recovery code is still needed.
- **Change it** (if someone may have seen it): Settings → **Security** → **Change the admin link**, with your current password (or no password within 10 minutes of a passkey sign-in). The old link, and every phone or laptop that used it, stop working at once; the new link is shown once (copy it, then **Open the new link** and bookmark it again) and emailed. The audit log notes the change, never the link.
- **Lost it?** Only a fingerprint of the link is kept, so it can't be shown again, by anyone, and "Forgot password" needs the link too. The only way back in is a new link, made on the server (on the VPS: SSH, or hPanel's browser terminal); the old one stops working:

```
podman exec beautifuluaehome node scripts/admin-link.mjs --new
```

  Without `--new` it only says when the link was made.
- **After restoring a backup:** the link from the backup works again. If you changed the link after that backup was taken, make a new one with the command above.

### First sign-in

- **Docker / PM2:** the first start prints a one-time password in the log (`docker compose logs app-blue` or `pm2 logs buhome-app`).
- Open your admin link and sign in with that email and password, then choose your own password: at least 12 characters, with at least 5 different characters.
- **Forgot password?** on the sign-in screen emails a link to the admin email (works once, for 30 minutes; it opens the Admin Hub by itself, also on a phone that has never had the admin link); every device is signed out when you choose the new password. It needs email set up (Settings → Email & admin account).
- No email set up? On the server: `docker compose exec app-blue rm /data/admin.json`, then `docker compose restart app-blue app-green`, then read the new one-time password with `docker compose logs app-blue` (Podman: `podman exec beautifuluaehome rm /data/admin.json`, `podman restart beautifuluaehome`, `podman logs beautifuluaehome`). You can also set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`).
- **Settings → Email & admin account:** your mail server (SMTP), where backups and alerts go, **Send a test email**, and your sign-in email (current password needed).
- 5 wrong passwords (or recovery codes) from one place pause sign-in there for 15 minutes; try again later or from another network. **Sign out** signs you out on every device.

### If you forget your password: passkeys and recovery codes

Set these up once, in **Settings → Passkeys & recovery codes**, so you can always get back in, even without email.

- **Passkey:** sign in with your phone's or computer's fingerprint, face or screen lock instead of the password. Type a name (e.g. "My iPhone") and your current password, press **Add a passkey**, and follow your phone or computer. Add one on each device you use; passkeys saved in iCloud Keychain or Google Password Manager follow you to your other devices. To sign in, press **Sign in with a passkey** on the sign-in screen. The list shows each passkey's name, when it was added and last used; **Remove** stops one working at once (do this for a lost phone; it asks for your password, or not if you signed in with a passkey in the last 10 minutes).
- **Forgot your password but have a passkey?** Sign in with the passkey, then within 10 minutes open Settings → Passkeys & recovery codes → **Forgot your password?** and choose a new one; the old one isn't asked for.
- Passkeys need the shop's real address: `NEXT_PUBLIC_APP_URL=https://yourdomain.ae` in .env.production (they work only on https://, or on http://localhost while testing). Open the Admin Hub at that address. If you move the shop to a new domain, add your passkeys again.
- **Recovery codes:** press **Create recovery codes** (current password needed, or not if you signed in with a passkey in the last 10 minutes). You get 10 codes like `ABCD-EFGH-JKLM-NPQR`, shown once: **Copy**, **Download** or **Print** them and keep them somewhere safe (a password manager, or on paper at home). Creating a new set makes the old codes stop working.
- **Using a code:** on the sign-in screen press **Use a recovery code**, type your admin email and one code. Each code works once. Every other device is signed out, you choose a new password, and the admin email gets a note that a code was used. Settings shows how many codes are left and warns when 2 or fewer remain: create a new set then.
- If your password is set on the server (`ADMIN_PASSWORD_HASH` in .env.production), a recovery code still signs you in, but the password can only be changed there: `npm run hash-password`, put the new hash in .env.production, restart the shop. In that setup **a recovery code is a full key to the Admin Hub for 30 minutes**, so keep the codes as safe as the password.
- **After restoring a backup:** the backup may be older than a passkey you removed or your newest codes, so restored recovery codes stop working and restored passkeys are switched off. Sign in with the password, then follow the banner (**Review now**): press **Keep** (password needed) on each passkey you still have, **Remove** the others, and create new recovery codes. Press **Done, hide this** when finished.
- The version (BUH-xx.xx.xx) shows bottom left on every page (in the shop it is only text). In the Admin Hub, tap it for **Settings → Versions**: every release with what changed, and (with automatic updates on) **Switch to this version** for any release from BUH-02.00.00, or **Update to the latest**. The shop stays open while it switches, and the database is saved first.
- **Going back below BUH-02.09.00 with card payments on** leaves card orders unchecked (older versions don't know them): switch card payments off in Settings → Payments first. Stripe keeps resending its webhooks until a version that knows them is back.
- **Going back below BUH-02.09.00 republishes your bank account** through the old public settings (older versions show the IBAN at checkout): clear the IBAN in Settings → Branding & bank first if it must stay private.
- **Going back below BUH-02.10.00:** a product edited in the older version loses its **Fitted sheet** tick and **Other pieces** (that version doesn't know them): after updating again, open the product and tick or type them again. During the update minute (both versions running), a product with no colours ordered through the older one answers "that colour is no longer offered": the customer just tries again. Orders not confirmed on WhatsApp are not cancelled by the older version; the newer one does it once it is back.
- **Updates** (with the updater turned on, see the deployment guide) install themselves without closing the shop or signing you out. If a new version does not start properly, the shop stays on the one before and an alert is written. A customer in the middle of checkout carries on: their bag, details and SMS code are kept.
- **One Podman container (a Windows laptop or a Linux server):** paste the one-line `setup` command once (Settings → Versions shows it, one line for Command Prompt and one for PowerShell; deployment guide, "One Podman container"). The images are private, so Podman must be logged in to `ghcr.io` first (deployment guide, "Private images"); when that login expires, Settings → Versions says so in red and updates wait until you log in again. The page also has a switch, **Install new versions automatically** (on by default): off, nothing is checked or installed by itself, but "Update to the latest", switching versions and restarting a stopped shop still work; it says when the last check ran and what it found. Under **Installed on this server** you see each version installed, with its digest, when, and why; a release marked "verified" runs exactly the contents it was first published with. If a version ever comes back with other contents, it is refused and the page warns you in red. Nothing is downloaded or kept on the computer but the images. The same then happens, with one difference: at the switch the shop is closed for a few seconds. The new version is tried first beside the running one, and if it does not answer, the old one is put back. Settings → Versions then says "Automatic updates: Podman (one container)". The shop keeps its own settings and port. From then on, update with **Update to the latest**, not with the old Podman commands (stop the updater first if you must). Without it, the page shows the two Podman commands to update by hand. The updater also keeps itself up to date. After the computer restarts, start Podman (`podman machine start`, or let Podman Desktop start it); the shop and the updater come back if Podman's restart service is on (the set-up prints the one line for it), otherwise run `podman start beautifuluaehome-updater` and it starts the shop.

### Orders

New orders appear under **Orders & Dispatches** within seconds, with a notice at the top. An order shows **via Instagram** (or WhatsApp, TikTok…) when that is where the customer came from. For each order:

- **Confirm & Assign Courier** books Jeebly or Eco Express and prints the label. For a cash-on-delivery order the customer hasn't confirmed on WhatsApp yet, it first asks **"This customer hasn't confirmed on WhatsApp yet — ship anyway?"** (you may have confirmed by phone call): **OK** books it and the "ship anyway" is kept in the order's **History** and the audit log; **Cancel** books nothing. With **Hold orders until confirmed on WhatsApp** on, it can't be booked at all until confirmed.
- **Mark dispatched**, then **Out for delivery** or **Mark delivered**, as the parcel moves.
- **Bank transfers** (filter **Transfer to check**, with a count of screenshots waiting): each order shows where it stands: **Waiting for bank transfer** → **Transfer screenshot received** → **Payment received**.
  - **View transfer screenshot** opens what the customer uploaded (hub only); earlier ones stay under **Earlier: #1, #2…**.
  - **Payment received** once the money is in the account (it asks you to confirm the amount). The order is marked paid, its private page closes, and **Tell the customer on WhatsApp** opens WhatsApp with "We've received your payment for order BUH-…, thank you ✓" ready to send. Tapping it twice changes nothing.
  - **Not received yet** if it isn't in the account: the customer can upload again, and **Tell the customer on WhatsApp** has a polite message with their link.
  - **Send bank details on WhatsApp** opens WhatsApp to the customer with the bank details, amount, reference and the order's private link already typed (for customers without email, or who asked on WhatsApp). The private link is also shown with a **Copy** button.
  - The order says whether the details were emailed. **History** shows each step (link made, emailed, screenshot uploaded, received).
  - The daily summary email counts the transfers to check and those not received yet.
- **Card payments** (filter **Card payments**) show how they were paid: **Paid by card · Apple Pay · Visa •••• 4242**, or **Waiting for the card payment** (not confirmed or booked until Stripe says paid; an order left unpaid for 10 minutes cancels itself and its items go back on sale). Only Stripe marks a card order paid: there is no "payment received" button for it.
  - **Cancel & refund AED … to the card** cancels a paid card order and refunds the full amount through Stripe (it reaches the customer's card in 5–10 working days). It happens once, even if tapped twice; it shows **Refund … on its way** until Stripe confirms, then **Refunded**.
  - A full refund you make in the Stripe dashboard instead also shows here.
  - **Cancel & refund AED X** refunds what is left of the payment: after a partial refund made in the Stripe dashboard it offers only the rest. A refund Stripe later reports as failed puts the order back to **Paid by card**, with a red note.
  - **Switched Stripe keys between test and live** (or removed the secret key) with card orders still open: Settings → Payments warns when you save. Unpaid ones cancel themselves (their items go back on sale). A paid one can't be refunded through the shop with the other keys: **Cancel & refund** then offers **Cancel without Stripe refund**, and you refund it in the Stripe dashboard of the account it was paid to.
- **A red note on an order** means it needs you: a refund that failed, a courier booking that came back after the order was cancelled or refunded (cancel that pickup in the carrier's portal), or a card order to refund in the Stripe dashboard. You also get an email (when email is set up) and Settings → System & backups lists it. Tap **Mark as handled** once done.
- **Cancel order** returns the items to stock. It cannot be undone.
- **History** shows the order's timeline: placed, WhatsApp confirmation asked, customer opened WhatsApp, confirmed (by whom, when), status changes.

Every change is recorded with who made it and when.

#### Confirm on WhatsApp (free, no WhatsApp API)

Customers confirm their number with one WhatsApp message they send you; nothing to sign up for or pay. With **Settings → Phone check** "WhatsApp (free)" (the default) this message is how every order is confirmed: no SMS code is sent at checkout.

- **Settings → Phone check:**
  - **WhatsApp (free)** (default, for new and existing shops) or **SMS code** (the SMS gateway or Firebase below; checkout as before, the WhatsApp step optional).
  - **Cancel orders not confirmed after (hours)**: 24 by default, 2 to 168. An order still not confirmed by then is cancelled by itself, its pieces back on sale (once), and the cancellation is in its **History** and the audit log. Never cancelled: orders confirmed on WhatsApp or by phone call (or shipped anyway), paid card orders, and bank transfers. A new value applies to new orders.
  - **If the customer never opens WhatsApp, cancel after (hours)**: 6 by default, 2 to 48, never later than the hours above. An order whose customer never even tapped **Confirm on WhatsApp** goes back on sale sooner (in its **History** as "WhatsApp never opened"); customers are told at checkout.
  - **Bank transfers are never cancelled by themselves** (their private payment page lasts 14 days). One still not confirmed after the hours above is flagged in Orders and emailed to you: **Bank transfer not confirmed after 24 h — check your bank, then cancel or confirm.** Its pieces stay held and the customer's page stays open until it is paid or cancelled (14 days at most).
  - **Limits** (no code costs anything, so nobody can hold your stock with fake orders): until confirmed, an order takes at most 2 of each item and 5 different items; at most 2 orders waiting per phone, 4 per connection and 60 across the shop; and orders waiting can hold at most half of any size's pieces (at least 2): beyond it the customer reads "This piece is very popular right now — please message us on WhatsApp". At 80% of the shop's limit, and whenever it turns a customer away, you get an email and Settings → System shows it.
  - **Behind no proxy** (no `TRUST_PROXY=1`), the shop can't tell customers apart: the section says so and the shop's limit is 15. The Hostinger set-up has `TRUST_PROXY=1`.
  - **No WhatsApp number set** (Settings → Store & contact): the section says so in red. Orders are still taken, never treated as confirmed, and marked **Not confirmed: no WhatsApp number set — call the customer**; they are not cancelled by themselves.
- **Settings → Store & contact:**
  - **Ask customers to confirm their order on WhatsApp**: on as soon as the shop's WhatsApp number is set (with Phone check "WhatsApp (free)" every order is asked anyway). With no number, nothing is asked.
  - **Hold orders until confirmed on WhatsApp**: off by default. Off, orders go through as usual and simply show "not yet confirmed". On, an order can't be confirmed or booked with a courier until you mark the message received (you can always cancel it).
- **In Orders** (phone view first), an order shows **Awaiting WhatsApp — auto-cancels in 13 h · code 1234** with the customer's phone number. When "Confirm my order BUH-… · code 1234" arrives in your WhatsApp, check it comes from that number, then tap:
  - **Confirmed on WhatsApp**; then **Reply on WhatsApp** opens a thank-you to the customer, ready to send;
  - **Confirmed by phone call** when you rang the customer instead (shown as "Confirmed by phone call by … at …"; it stops the auto-cancel);
  - **Ask to confirm** opens WhatsApp to the customer with "Hello Salma, please confirm your order BUH-… from Beautiful UAE Home by replying YES. Thank you!" ready to send;
  - or **Number didn't match** (from another number). Then either call the customer, cancel, or type the number it came from and tap **Use the number it came from**: the box asks you to confirm the number exactly as it will be saved (+9715…), the order's phone becomes that number (checked like checkout's: a UAE mobile), the old one stays in the order's **History**, and the order is confirmed. You can still tap **Confirmed on WhatsApp** later.
  - **Typed the wrong number?** On a confirmed order, open **Correct the phone number**, type the right one and save: checked the same way, in the order's **History** and the audit log. Not on a cancelled or delivered order. Track Order finds the order with the current number or any number it had before.
- **An order that is cancelled (by you, or by itself) or delivered can't be confirmed any more**: the tap answers "Auto-cancelled at … — ask the customer to place a new order" (its pieces are back on sale).
- The **Awaiting WhatsApp** filter lists the ones still waiting, and the daily summary counts them. A second tap changes nothing; each answer is in the audit log with who and when.
- With Phone check "SMS code", the SMS / Firebase code check at checkout works as before and this step is optional.

### Inventory

**Inventory** lists every product with a photo and its pieces per size as coloured chips: **brick red** sold out, **ochre** low (at or below the warning level in Settings → Catalogue, 2 unless you change it), **sage green** in stock. Most designs are one or two pieces, so stock is kept per size.

- **Search** by name or SKU (your own stock code, set under the editor's **More details**).
- **Show:** All, **Low** (a few pieces left in all), **Sold out** (none left in any size), **Hidden**, **Removed**; and a **Category** list. The two cards at the top (sold out, running low) open those lists, and the number on **Inventory** in the bottom bar is the same count.
- Tap a product to open it: the sizes with **− / +**, then the quick actions below.
- **Edit** opens the step-by-step editor; **+ Add product** starts a new one (see below).
- **Check measurements** (a small ochre badge): the update that brought measurements per product kept every measurement the shop showed before (nothing is filled in), fitted sheets ticked as fitted, and took off only a duvet cover that was just the standard size's on a set that isn't a duvet product (a duvet cover you typed yourself stays). Open **Edit → Sizes** once, keep only what each set includes, and save: the badge goes. A duvet cover taken off is kept: the editor shows **Taken off the shop by the update** with **Put it back** (one tap, then save).
- **Hide / Show in shop**, **Sold out** (every size to 0, with Undo), **Duplicate** (a hidden copy with no stock, for another colour: change its photos and colour, then show it), **Share** (the product's link, through your phone's share sheet or copied), **History**, the arrows (its place in the shop) and **Remove** (out of the shop for good but kept for past orders; restore it, hidden, under **Removed**).

### Managing stock from your phone

On a phone the bottom bar is **Orders**, **Inventory**, **Chats** and **More** (Add product, Customers, Settings, View shop).

- **− / +** next to a size takes away or adds one piece. It is saved at once: a message says what changed (for example `King 5 → 6`) with **Undo**. Several quick taps are saved together as one change.
- **Tap the number** to type it (for example after counting the shelf); **Enter** saves it.
- **Reason for − / +** (above the list) is recorded with each change: **Correction** (a count), **Sold offline** (a sale outside the shop), **Damaged**, or **Received**.
- **Received stock** adds new pieces to several sizes at once, with an optional note (supplier, invoice).
- **Changed on another device: refresh.** If another phone, a laptop or a customer's order changed the same stock since your screen last updated, your change is not saved (nothing is overwritten). Tap **Refresh**, check the numbers and try again.
- A weak connection is fine: a change that did not get an answer is sent again, and the shop makes sure it counts once.
- **History** shows the latest changes of a product: when, who, why, and every size's old → new. Every change is also in the audit log and in `stock_moves.csv` in each backup.

**Adding a product from the phone** goes in four steps; **Next** moves on, and the step names at the top go back:

1. **Photos:** **Take photo** opens the camera; **From gallery** picks several at once. Each is made smaller on the phone (at most 1600 px) and uploaded straight away. The first photo is the **cover**: tap the star to make another one the cover, or the arrows (or drag, on a computer) to change the order.
2. **Details:** name, category and price; **More details** has the SKU, the "was" price, descriptions, fabric and colours. **Colours are optional:** with none, the shop shows no colour; with one, it shows it as a label; with several, shoppers choose one.
3. **Sizes:** tap a size (from your presets in Settings → Catalogue) to add it, then set its pieces with **− / +** or type them.
   - **Fitted sheet (elastic corners):** tick it when the set's sheet is fitted; left unticked (the default), the set has a flat sheet. The shop shows "Fitted sheet" or "Flat sheet" with its size.
   - **Measurements & price** under each size: the sheet, **Pillowcases**, **Duvet cover** and **Other pieces** (e.g. cushion covers) of this product. They start empty: fill in only what the set includes. **Use standard sizes** fills the empty ones from the size preset (sheet and pillowcases; the duvet cover only for a duvet product), shown greyed as a hint until then. The shop shows only the lines you filled in, and no Measurements at all when there are none.
4. **Publish:** shown in the shop (or **Save hidden**), new arrival, featured.

The draft saves itself as you go ("Draft saved" at the top), so a phone call or a closed tab loses nothing; open **Add product** again (on any device) to continue, or **Start over**. Editing a product works the same way; if a customer buys while you edit its stock, **Save** shows the new figures to check.

### Chats

The **Help** button on the shop opens a chat. The assistant answers by itself from what you taught it (Settings → **Chat assistant**) and from your size presets; it never makes up a price, a discount or a promise. Anything else, or **Talk to a person**, comes to you:

- **Chats** in the Admin Hub (badge: waiting for you). Reply there; the customer sees it within seconds. **WhatsApp** / **Email** open their contact details; **Close** ends the chat, **Back to assistant** lets the assistant answer again.
- An email to the backup address, with the conversation. **Reply to that email** and your answer appears in the chat (needs the mailbox in Settings → Email & admin account; keep `[Chat #…]` in the subject).
- If nobody answers within the waiting time (2.5 minutes by default), the customer is told once that we'll get back to them, and asked for a phone number or email if they haven't left one. A reply you write after they've left is emailed to them, when they left an email; for a phone number, use **WhatsApp**.

**Settings → Chat assistant:** switch the chat on or off, its name and greeting, the waiting time, and **What it knows**: each answer has a question, keywords and the answer text. **Try it** shows what it would reply. **Download memory** saves the answers as a file (keep a copy, or edit and **Load from file**).

On each product, customers see **Ask in chat**, **Ask on WhatsApp** and **Ask on Instagram**, only the ones switched on (Settings → Store & contact). Instagram can't pre-fill a message, so the product's link is copied for them to paste.

### Customers

**Customers** (under **More** on a phone) is built from the orders: one line per phone number, with the number of orders and the total spent.

### Money: expenses, reports and the audit log

On a phone: **More → Money**; on a laptop: the **Money** tab. Three parts: **Expenses**, **Reports** and **Audit log**.

**Expenses (with a photo of the bill)**

1. Tap **Add expense**.
2. Check the date (today is filled in), type the amount in AED (`125.50`), pick the category, who you paid and how (cash, card, bank transfer, other). Add a note if it helps.
3. Tap **Take photo** to photograph the bill with the camera, or **Photo or PDF** to pick one (a PDF invoice from an email works too). Add more than one if the bill has several pages.
4. Tap **Save expense**.

- **Categories:** Stock & fabric, Packaging, Courier & delivery, Marketing & ads, Rent, Utilities, Software & fees, Bank & card charges, Other. **New** next to the list adds your own.
- **Photos are made smaller** (they stay readable) and their location and camera details are removed before they are stored. Each bill can be up to 10 MB.
- **Edit** keeps the earlier version: **History** shows every version, who changed it and when. If you edited the same expense on another device meanwhile, you are asked to refresh first.
- **Remove** asks why. The expense leaves the totals but is never deleted: **Show removed** lists it with who removed it, when and why. A bill taken off (the **×** next to it) is kept the same way.
- Stripe's fees: add them each month as an expense (Bank & card charges) from Stripe's statement.

**Reports and the export for your accountant**

1. Pick **Month**, **Quarter**, **Year** or **Dates** (any dates). Dates are UAE time.
2. The totals appear: net sales, expenses and profit; gross sales, refunds and what is not marked paid yet; each payment method (cash on delivery, bank transfer, card); expenses by category.
3. Tap **Export for my accountant (ZIP)** and send the file to your accountant (WhatsApp, email or a drive).

- **Your financial year starts in:** January (the calendar year) unless you choose another month; quarters and years follow it.
- **What counts as a sale:** every order placed in the period, except orders cancelled before any money was taken, card orders still waiting for payment, and Stripe test payments. A card payment refunded later shows as a sale (when placed) and a refund (when refunded).
- **The ZIP** holds `summary.html` (open and print, or Print → Save as PDF), `summary.csv`, `sales.csv` (one row per order: date, number, customer name, emirate, items, amounts, payment method and reference, refund, status, courier and AWB), `order-items.csv`, `expenses.csv`, every bill in `bills/` (named date_category_amount_expense), the period's audit log with its check, and a `README.txt` explaining each file. The CSVs open in Excel (Arabic names included).
- **VAT:** the shop is not VAT-registered and no VAT is added. Reports show your sales of the last 12 months against the AED 375,000 mandatory registration threshold; from 80% it turns amber (Settings → System & backups shows it too, and you get an email). Talk to your accountant then.

**Audit log**

A read-only list of everything that changes money or the shop, newest first: orders placed and changed (status, cash collected, notes), payments, refunds and declines, transfers checked, stock moves, products and prices (before → after), settings, the admin link, sign-ins (and refused ones), passwords, passkeys and recovery codes, backups and restores, updates asked for, expenses and their bills, and every export.

- Filter by dates, **What** (for example "All payment" or `expense.created`), **Who** and an order or expense number; **CSV** and **JSONL** download what is shown (each download is itself recorded).
- The green line **"The log is intact"** means every entry's signature and its link to the one before were checked. If anything was changed, removed or reordered it turns red and says where (file and line). After restoring onto a new server, it says the older months were signed with that server's key and can't be checked here.

### Settings

**Settings** holds every option, in sections. Changes **save themselves** a moment after you stop typing ("Saved automatically · Undo"); **Undo** puts back what was there before your current round of changes, and Settings → System & backups → history keeps earlier versions. A change that isn't valid is not saved, and new mail settings are tried first: if they can't connect, the working ones stay. Passwords and keys are saved only when you press **Save**.

**Settings** sections:

- **Store & contact:** your WhatsApp number (change it any time; empty hides the WhatsApp buttons), the message a chat opens with, the floating WhatsApp button, the support email, Instagram, TikTok and Facebook, which of **Ask on WhatsApp / Instagram** show, the address, and whether visitors abroad see their own currency.
- **Announcement bar** (at the end of Store & contact): **Show the bar**, and up to **3 lines of up to 60 characters** each (a counter shows how many; emoji are left out; the shop refuses longer or more). **Use the suggested lines** puts back the defaults: *Free delivery across the UAE in 1–2 days*, *Cash on delivery*, *Handmade in small batches*. The **Preview** is the bar as customers see it. Press **Save announcements**. While a festival is on, its greeting takes the first place in the bar (Settings → Festival themes → **Festival lines in the scrolling bar**), still three lines at most.
- **Chat assistant:** see Chats above.
- **Delivery:** the emirates you deliver to, areas you don't serve (a short form counts: "JVC" also covers "Jumeirah Village Circle (JVC)"), the delivery time customers see (1–2 days), and same-day delivery: switch it on, set the extra charge, the cut-off time (UAE) and where it's offered. Customers see a green tick for their area and choose standard or same day; the courier is never named to them.
- **Email & admin account:** the mail server, where backups and alerts go, the mailbox for chat replies, and your sign-in email.
- **Security:** your private admin link: **Change the admin link** (see "Your private admin link" above).
- **Passkeys & recovery codes:** your ways back in if you forget the password (see above).
- **Catalogue:** the size presets offered when adding a product (name, measurements, price difference, pieces in the set), the categories shown in the shop (each category with pieces in it is a round story chip at the top of the shop, in this order, with its first piece's photo; **New in** and **On sale** chips come from each product's **New arrival** tick and its **Was (AED)** price), and the **Only N left** level.
- **Branding & bank:** the shop's name, tagline and logo (the logo's letters sit on one of the palette's tones: champagne gold, antique gold, ink or dusty rose), and bank-transfer details.
- **Festival themes:** see below.
- **Payments:** card, Apple Pay and Google Pay through your Stripe account (see "Card payments" above).
- **Phone check:** WhatsApp (free, the default) or SMS code, the hours before unconfirmed orders cancel, and the SMS gateway (see below).
- **Couriers:** see below.
- **System & backups:** health (disk, database, backups, SMS), backups, and **Settings history**: every save keeps the version it replaced (keys excepted); **Restore** puts an earlier one back and can itself be undone.

### Festival themes

From 3 weeks before a major festival until 1 week after, a soft greeting band sits at the top of the shop and the announcement bar opens with its greeting (smaller festivals: about a week before to two days after; solemn days such as Good Friday and Commemoration Day only on the day, with a calm look). 32 festivals are included: the UAE's national days, Ramadan and the Eids, Diwali, Holi, Onam, Navratri, Vaisakhi, Christmas, Easter (and the Orthodox ones), Lunar New Year, Nowruz and more.

A festival never brings loud colours of its own: it shifts the shop's accent to one of a few curated tones that sit with the ivory and gold, and adds one delicate line motif to the greeting band (faintly repeated behind it) and to the ring of the chosen story chip:

| Festivals | Accent | Motif |
| --- | --- | --- |
| Eid al-Fitr, Eid al-Adha | deep emerald and gold | crescent and star |
| Ramadan, Mawlid | deep emerald | lantern |
| UAE National Day, Flag Day | deep emerald, with a quiet nod to the flag | four fine bands in muted flag colours |
| Diwali, Gurpurab | warm saffron and gold | diya |
| Onam, Vishu, Pongal, Vaisakhi, Ganesh Chaturthi | saffron | blossom, sun, wheat, lotus |
| Christmas, Orthodox Christmas, Lunar New Year, Valentine's Day | deep berry and gold | snowflake, star, cloud, heart |
| Holi, Navratri, Raksha Bandhan, Mother's Day, Women's Day | dusty rose | rangoli, lotus, blossom |
| Hijri New Year, Isra and Mi'raj, Laylat al-Qadr, New Year | midnight blue and gold | crescent, star, sparkle |
| Easter, Orthodox Easter, Nowruz | sage | blossom, olive, sprout |
| Good Friday, Commemoration Day | stone grey (calm) | olive branch |

The greeting is a short, gracious line (for example *Eid Mubarak* with *Fresh linen for Eid mornings and the guests who follow*); the phone's status bar takes the accent's deep shade.


- Dates are built in and checked online every week from public holiday calendars (UAE official dates win for the Islamic festivals); **Refresh dates now** checks straight away.
- **Always this look** keeps one theme; **Everyday look only** turns themes off; untick **Show** to skip a festival.
- **Preview** (at the top of the section) shows any festival's greeting band and bar line before you choose it; nothing changes in the shop until you pick it under **Always this look**.

### Instagram, WhatsApp and the product feed

- Every product has its own link, `https://yourdomain.ae/p/<product>`, which previews with the photo, name and price when pasted in WhatsApp or Instagram. **Share** on a product copies or sends it.
- **Instagram / Facebook Shopping and Google:** add `https://yourdomain.ae/feeds/meta.csv` as a scheduled data feed in Meta Commerce Manager (or Google Merchant Center). It lists every product and size with live stock.
- Links you post can carry `?utm_source=instagram&utm_campaign=eid`; orders then show where customers came from.

### Daily summary and alerts

Every morning at 8:00 (UAE) an email to the backup address lists yesterday's orders and sales, orders waiting for you (and for the customer's WhatsApp message), what is sold out or low, and anything needing attention. A problem (low disk space, a database or backup failure, no SMS gateway) is emailed when it starts, daily while it lasts, and when it is resolved.

### Card payments, Apple Pay and Google Pay (Stripe)

Customers pay by card, Apple Pay or Google Pay into **your own Stripe account**; cash on delivery and bank transfer stay as they are. Off until you switch it on in **Settings → Payments**. Card numbers go straight to Stripe and never reach the shop.

1. **Stripe account.** Sign up at stripe.com (business in the UAE, currency AED) and finish **Activate payments** so the account can take real payments. Until then use test mode.
2. **API keys.** Stripe → **Developers → API keys** (test mode first: the toggle at the top right of Stripe). Copy the **Publishable key** (`pk_test_…`) and the **Secret key** (`sk_test_…`; a restricted `rk_…` key with write access to PaymentIntents, Refunds and Payment method domains, and read access to Account, also works) into **Settings → Payments**.
3. **Webhook.** Stripe → **Developers → Webhooks → Add endpoint**:
   - **Endpoint URL:** the address shown in Settings → Payments (**Copy**), e.g. `https://beautifuluaehome.com/api/stripe/webhook`;
   - **Events:** `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.refund.updated`;
   - then open the endpoint, **Signing secret → Reveal**, and paste it (`whsec_…`) into **Webhook signing secret**.
4. Tick **Take card payments at checkout** and **Save payment settings**. Saving needs all three keys, from the same mode. **Check the connection** shows your Stripe account's name and whether it can take payments. The badge says **Test mode: no real money** or **Live mode: real payments**.
5. **Apple Pay:** tap **Register this domain for Apple Pay** (once in test mode and once in live mode; Stripe hosts the verification file for you). It shows "Apple Pay ready". Google Pay needs nothing more.
6. **Try it in test mode:** at checkout choose **Card** and use `4242 4242 4242 4242`, any future date, any CVC; `4000 0000 0000 9995` is declined; `4000 0027 6000 3184` asks for 3-D Secure. The order shows **Paid by card · Visa •••• 4242** in Orders.
7. **Go live:** in Stripe switch off test mode, add the live webhook endpoint (same address and events) and copy the live keys (`pk_live_…`, `sk_live_…`) and the live signing secret into Settings → Payments, **Save**, then **Register this domain for Apple Pay** again.

- Prices, totals and the same-day charge are worked out by the shop, never by the phone; Stripe is asked for exactly the order's total in AED.
- An order counts as paid only when Stripe says so (its signed webhook, or the shop asking Stripe). A card order not paid within 10 minutes is cancelled and its pieces go back on sale.
- **Phone codes:** with an SMS gateway switched on (Settings → SMS), card customers verify their mobile with a code too, like every order (once per checkout, also with Apple Pay and Google Pay). Without a gateway, card orders need no code, and are limited to 2 of each item and 5 different items.
- If a customer's connection drops while paying, checkout never says "nothing was charged" unless Stripe refused the card: it says to check the connection and offers **Check again**; paying again continues the same order, so nobody is charged twice.
- The daily summary email counts yesterday's card takings and refunds.
- **Keys are not in backups:** after restoring a backup, enter the secret key and webhook signing secret again.

### Bank details

Under **Settings → Branding & bank → Bank transfer details**. These are **never shown on the website**: each customer who chooses bank transfer gets them privately (the email, your WhatsApp message, and their order's private page), with your note. **Preview what customers receive** shows the email and the WhatsApp message exactly.

- **Bank transfer only appears at checkout once the bank name, account name and IBAN are saved.**
- The email is sent automatically when the customer gives an email address and **Settings → Email** is set up; replies (with screenshots) come to your support email.
- The IBAN is checked (AE plus 21 digits, with its check digits), so most typos are caught.
- The order's private link goes into emails and WhatsApp messages only when the shop's address is set (`NEXT_PUBLIC_APP_URL` in the settings file); without it, customers are asked to reply with the screenshot instead.
- Each order keeps its latest 5 screenshots (older ones are deleted). If the server is short of space (under 1 GB free, or 2 GB of screenshots), the customer is asked to send it on WhatsApp instead, you get an email, and Settings → System & backups says so.

### Backups

The line at the top of the Admin Hub shows when the last backup ran:

- **green:** recent and emailed;
- **amber:** taken but not emailed (check the `SMTP_*` settings), or emailed without a `BACKUP_PASSPHRASE`;
- **red:** failed or overdue.

**Back up now** runs one immediately. Backups run every 12 hours on their own, with your expenses and every bill photo. Courier, SMS and Stripe keys are not in backups: after a restore, enter them again. Restoring: see HOSTINGER_DEPLOYMENT_GUIDE.md.

### Phone check and the SMS gateway

**Settings → Phone check** chooses how checkout checks the number: **WhatsApp (free)** (the default; see [Confirm on WhatsApp](#confirm-on-whatsapp-free-no-whatsapp-api)) or **SMS code**. The SMS gateway below is used only with **SMS code**; with WhatsApp a saved gateway sends nothing.

Enter the gateway's details, tap **Send test** to try it on your own mobile, then **Save Gateway Credentials**. Checkout then sends codes through it (a gateway set in `.env.production` takes priority). Keys are kept on the server and never shown again: leave a key field blank to keep the saved one. Webhook and Infobip URLs must be public https addresses.

**Firebase Phone Auth** (optional): Google sends the code instead of your gateway.

1. Create a project at console.firebase.google.com.
2. Authentication → Sign-in method: turn on **Phone**.
3. Authentication → Settings → Authorized domains: add your shop's domain.
4. Upgrade to the **Blaze** plan. Firebase only sends phone codes on Blaze, and Google bills every SMS; set a budget alert.
5. Project settings → add a Web app, copy `apiKey`, `authDomain`, `projectId` and `appId` into **Settings → Phone check** (SMS gateway), choose **Firebase Phone Auth** and save, and set Phone check to **SMS code**.

There is no **Send test** for Firebase: try a checkout on your own phone (a billed SMS). A gateway in `.env.production` still takes priority.

### Couriers

Enter the Jeebly and Eco Express keys and use **Test connection**. Keys are kept on the server and never shown again: leave a key field blank to keep the saved one.

- **Sandbox mode** gives simulated AWBs, labelled as such.
- **Live mode** books with the carrier. If the carrier refuses, you see why, and the order stays unbooked.
- **Booking the same order again** shows the AWB already issued; it never books twice.
- **"No answer from the carrier"** means the shipment may or may not have been created. Check the carrier portal for the order number first. The next attempt asks you to confirm before booking again.

### Audit log files

The log is kept in `DATA_DIR/audit-YYYY-MM.jsonl` (one file a month, in backups too); read it in **Money → Audit log**. Each line is chained to the one before, so edits are detectable.
