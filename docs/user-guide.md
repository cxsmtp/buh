# User guide

## For customers: browsing the shop

The shop looks and works like a boutique's Instagram page, on a phone first.

- **At the top:** the shop's logo, name, tagline and address (Settings → Branding & bank, Store & contact), how delivery and payment work, and the festival greeting when one is on.
- **Round story chips:** **All**, **New in** and **On sale** (each only when it shows fewer pieces than All), then one per category, in the order of Settings → Catalogue, each with a photo from inside it. A category with no pieces in the shop has no chip. One tap shows just that.
- **The feed:** big photos, two across on a phone (three or four on a computer), with the name, the price (and the price before, crossed out, when it is reduced) and **Only 1 left** or **Sold out** from the real stock.
- **Tap a photo** and the product opens full screen: swipe the photos (or use the arrows, the dots or the arrow keys), choose the size and colour, **Add to Bag**, or **Ask in chat / on WhatsApp / on Instagram**. **Share** sends its link. The phone's Back button closes it.
- **Filter** (next to the number of pieces) opens a sheet with only the choices that make a difference for the pieces in the shop: category, size, colour (worked out from each colour's swatch: blue, cream, red…), price range, **In stock only**, **On sale**, **New in**, and the sort (newest, price). Each choice shows how many pieces it leaves; **Show N pieces** applies them. Every filter on shows as a chip under the button: tap it to remove it, or **Clear all**.
- **Search** (the tab bar on a phone, the magnifier on a computer) finds pieces by name, colour, category or fabric as you type; tap one to open it, or **See all** to show them in the shop.
- **Links keep the view:** the address holds the search, filters and the open product, so a filtered view can be sent on WhatsApp and Back steps through what you looked at.
- **On a phone** the tab bar at the bottom has **Home** (back to the top), **Search**, **Bag** and **Orders** (Track Order); the Help button sits just above it.
- Everything works with the keyboard (Tab, Enter, Escape closes a sheet), and the shop moves less for people whose phone is set to reduce motion.

## For customers: placing an order

1. Choose a set, a bed size and a colour, then **Add to Bag** and **Proceed to Checkout**.
2. **Verify your UAE mobile.** Type the number (50 123 4567, 050…, +971… all work) and tap **Send code**. Enter the 6-digit code from the SMS; it is checked as soon as the sixth digit is in. Pasting the code or using the phone's autofill works too.
   - The code is valid for 10 minutes, and a new one can be requested after 30 seconds.
   - After 5 wrong tries the code stops working; request a new one.
   - **Outside the UAE?** As soon as a non-UAE number is typed, checkout shows **Email orders@…**, which opens an email with the bag already listed.
   - **SMS not arriving?** If the shop's SMS service is down, checkout says so and offers the shop's email.
3. Fill in the delivery address (or **Use My GPS**), choose Cash on Delivery or bank transfer (with an optional receipt screenshot or PDF), and **Confirm & Raise Order**. The button stays locked until the phone is verified.
4. **Track Order:** enter the order number (shown on the confirmation and pre-filled on the same phone) and the mobile number used for the order.
- **Picking up where you left off.** The bag and your delivery details are kept on your phone (**Not you? Clear them** at checkout forgets the details). **Save or send this bag as a link** carries it to another browser, e.g. from Instagram's built-in browser to Safari or Chrome.
- **Most designs are one or two pieces.** A size shows **Only 1 left** or **Sold out**; you can't add more than there are, and a sold-out size offers **Ask us** (WhatsApp or email) instead.
- Prices are in AED. Visitors outside the UAE also see an approximate price in their own currency; you always pay in AED.
- Stock and prices update on the open page within seconds. Prices and stock are always checked by the shop when the order is placed.
- **Share** on a product sends its link (with its photo in the preview) through WhatsApp or the phone's share sheet.

- **Delivery** is free, in 1–2 days, to all seven emirates; a green tick confirms the address. Where the shop offers it, **Same day** can be chosen for an extra charge before the cut-off time. **Use My GPS** saves the location for the driver and suggests the area; if the phone or laptop reports a location outside the UAE (common with network or VPN locations), it says so and you choose the emirate and area yourself.

## For the owner: the Admin Hub

### First sign-in

- **Docker / PM2:** the first start prints a one-time password in the log (`docker compose logs app-blue` or `pm2 logs buhome-app`).
- Sign in from **Admin Hub** with that email and password, then choose your own password: at least 12 characters, with at least 5 different characters.
- **Forgot password?** on the sign-in screen emails a link to the admin email (works once, for 30 minutes); every device is signed out when you choose the new password. It needs email set up (Settings → Email & admin account).
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
- The version (BUH-xx.xx.xx) shows bottom left on every page. In the Admin Hub, tap it for **Settings → Versions**: every release with what changed, and (with automatic updates on) **Switch to this version** for any release from BUH-02.00.00, or **Update to the latest**. The shop stays open while it switches, and the database is saved first.
- **Updates** (with the updater turned on, see the deployment guide) install themselves without closing the shop or signing you out. If a new version does not start properly, the shop stays on the one before and an alert is written. A customer in the middle of checkout carries on: their bag, details and SMS code are kept.
- **One Podman container (Windows):** run `scripts\podman-autoupdate.bat` once in the shop folder (deployment guide, "Podman on Windows") and the same happens, with one difference: at the switch the shop is closed for a few seconds. The new version is tried first beside the running one, and if it does not answer, the old one is put back. Settings → Versions then says "Automatic updates: Podman (one container)". The shop keeps its own settings and port. From then on, update with **Update to the latest**, not with the old Podman commands (stop the updater first if you must). Without it, the page shows the two Podman commands to update by hand. After Windows restarts, start Podman (`podman machine start`, or Podman Desktop); the updater then starts the shop.

### Orders

New orders appear under **Orders & Dispatches** within seconds, with a notice at the top. An order shows **via Instagram** (or WhatsApp, TikTok…) when that is where the customer came from. For each order:

- **Confirm & Assign Courier** books Jeebly or Eco Express and prints the label.
- **Mark dispatched**, then **Out for delivery** or **Mark delivered**, as the parcel moves.
- **Bank transfers:**
  - **View receipt** opens what the customer uploaded.
  - **Mark payment received** once the money is in the account.
- **Cancel order** returns the items to stock. It cannot be undone.

Every change is recorded with who made it and when.

### Inventory

**Inventory Stock** lists every product with its pieces per size (most designs are one or two pieces, so stock is kept per size).

- **+ / −** next to a size adds or removes one piece straight away.
- **Edit** opens everything: photos (up to 8; the first is the main one; reorder or remove them), name, prices, category, material, colours, sizes (add from your presets, change measurements and price differences) and pieces per size, and whether it is shown, featured or new.
- **+ Add Product** (or **+ Add** on a phone) opens the same editor for a new product. Phone photos are shrunk before upload.
- **Visible / Hidden** shows or hides a product; the arrows change its place in the shop.
- **Remove** takes a product out of the shop for good, but keeps it for past orders; it can be restored (hidden) under **Removed**.
- Filters: **Low** (at or below your warning level), **Sold out**, **Hidden**, **Removed**, and a search box.
- If a customer buys while you are editing stock, **Save** says the stock changed and shows the new figure: check it and save again.

### Chats

The **Help** button on the shop opens a chat. The assistant answers by itself from what you taught it (Settings → **Chat assistant**) and from your size presets; it never makes up a price, a discount or a promise. Anything else, or **Talk to a person**, comes to you:

- **Chats** in the Admin Hub (badge: waiting for you). Reply there; the customer sees it within seconds. **WhatsApp** / **Email** open their contact details; **Close** ends the chat, **Back to assistant** lets the assistant answer again.
- An email to the backup address, with the conversation. **Reply to that email** and your answer appears in the chat (needs the mailbox in Settings → Email & admin account; keep `[Chat #…]` in the subject).
- If nobody answers within the waiting time (2.5 minutes by default), the customer is told once that we'll get back to them, and asked for a phone number or email if they haven't left one. A reply you write after they've left is emailed to them, when they left an email; for a phone number, use **WhatsApp**.

**Settings → Chat assistant:** switch the chat on or off, its name and greeting, the waiting time, and **What it knows**: each answer has a question, keywords and the answer text. **Try it** shows what it would reply. **Download memory** saves the answers as a file (keep a copy, or edit and **Load from file**).

On each product, customers see **Ask in chat**, **Ask on WhatsApp** and **Ask on Instagram**, only the ones switched on (Settings → Store & contact). Instagram can't pre-fill a message, so the product's link is copied for them to paste.

### Customers

**Customers & CRM** is built from the orders: one line per phone number, with the number of orders and the total spent.

### Settings

**⚙️ Settings** holds every option, in sections. Changes **save themselves** a moment after you stop typing ("Saved automatically · Undo"); **Undo** puts back what was there before your current round of changes, and Settings → System & backups → history keeps earlier versions. A change that isn't valid is not saved, and new mail settings are tried first: if they can't connect, the working ones stay. Passwords and keys are saved only when you press **Save**.

**⚙️ Settings** sections:

- **Store & contact:** your WhatsApp number (change it any time; empty hides the WhatsApp buttons), the message a chat opens with, the floating WhatsApp button, the support email, Instagram, TikTok and Facebook, which of **Ask on WhatsApp / Instagram** show, the address, and whether visitors abroad see their own currency.
- **Chat assistant:** see Chats above.
- **Delivery:** the emirates you deliver to, areas you don't serve, the delivery time customers see (1–2 days), and same-day delivery: switch it on, set the extra charge, the cut-off time (UAE) and where it's offered. Customers see a green tick for their area and choose standard or same day; the courier is never named to them.
- **Email & admin account:** the mail server, where backups and alerts go, the mailbox for chat replies, and your sign-in email.
- **Passkeys & recovery codes:** your ways back in if you forget the password (see above).
- **Catalogue:** the size presets offered when adding a product (name, measurements, price difference, pieces in the set), the categories shown in the shop (each category with pieces in it is a round story chip at the top of the shop, in this order, with its first piece's photo; **New in** and **On sale** chips come from each product's **New arrival** tick and its **Was (AED)** price), and the **Only N left** level.
- **Branding & bank:** logo, colours, the scrolling bar, and bank-transfer details.
- **Festival themes:** see below.
- **Phone verification:** the SMS gateway (see below).
- **Couriers:** see below.
- **System & backups:** health (disk, database, backups, SMS), backups, and **Settings history**: every save keeps the version it replaced (keys excepted); **Restore** puts an earlier one back and can itself be undone.

### Festival themes

From 3 weeks before a major festival until 1 week after, the banner shows its greeting and colours and the scrolling bar its lines (smaller festivals: about a week before to two days after; solemn days such as Good Friday and Commemoration Day only on the day, with a calm look). 32 festivals are included: the UAE's national days, Ramadan and the Eids, Diwali, Holi, Onam, Navratri, Vaisakhi, Christmas, Easter (and the Orthodox ones), Lunar New Year, Nowruz and more.

- Dates are built in and checked online every week from public holiday calendars (UAE official dates win for the Islamic festivals); **Refresh dates now** checks straight away.
- **Always this look** keeps one theme; **Everyday look only** turns themes off; untick **Show** to skip a festival.

### Instagram, WhatsApp and the product feed

- Every product has its own link, `https://yourdomain.ae/p/<product>`, which previews with the photo, name and price when pasted in WhatsApp or Instagram. **Share** on a product copies or sends it.
- **Instagram / Facebook Shopping and Google:** add `https://yourdomain.ae/feeds/meta.csv` as a scheduled data feed in Meta Commerce Manager (or Google Merchant Center). It lists every product and size with live stock.
- Links you post can carry `?utm_source=instagram&utm_campaign=eid`; orders then show where customers came from.

### Daily summary and alerts

Every morning at 8:00 (UAE) an email to the backup address lists yesterday's orders and sales, orders waiting for you, what is sold out or low, and anything needing attention. A problem (low disk space, a database or backup failure, no SMS gateway) is emailed when it starts, daily while it lasts, and when it is resolved.

### Bank details

Under **⚙️ Settings → Branding & bank → Bank transfer details**. Customers paying by transfer see exactly these at checkout, with your instructions.

- **Bank transfer only appears at checkout once the bank name, account name and IBAN are saved.**
- The IBAN is checked (AE plus 21 digits, with its check digits), so most typos are caught.

### Backups

The line at the top of the Admin Hub shows when the last backup ran:

- **green:** recent and emailed;
- **amber:** taken but not emailed (check the `SMTP_*` settings), or emailed without a `BACKUP_PASSPHRASE`;
- **red:** failed or overdue.

**Back up now** runs one immediately. Backups run every 12 hours on their own. Courier and SMS keys are not in backups: after a restore, enter them again. Restoring: see HOSTINGER_DEPLOYMENT_GUIDE.md.

### Phone verification (SMS)

Enter the gateway's details, tap **Send test** to try it on your own mobile, then **Save Gateway Credentials**. Checkout then sends codes through it (a gateway set in `.env.production` takes priority). Keys are kept on the server and never shown again: leave a key field blank to keep the saved one. Webhook and Infobip URLs must be public https addresses.

**Firebase Phone Auth** (optional): Google sends the code instead of your gateway.

1. Create a project at console.firebase.google.com.
2. Authentication → Sign-in method: turn on **Phone**.
3. Authentication → Settings → Authorized domains: add your shop's domain.
4. Upgrade to the **Blaze** plan. Firebase only sends phone codes on Blaze, and Google bills every SMS; set a budget alert.
5. Project settings → add a Web app, copy `apiKey`, `authDomain`, `projectId` and `appId` into **Settings → Phone verification**, choose **Firebase Phone Auth** and save.

There is no **Send test** for Firebase: try a checkout on your own phone (a billed SMS). A gateway in `.env.production` still takes priority.

### Couriers

Enter the Jeebly and Eco Express keys and use **Test connection**. Keys are kept on the server and never shown again: leave a key field blank to keep the saved one.

- **Sandbox mode** gives simulated AWBs, labelled as such.
- **Live mode** books with the carrier. If the carrier refuses, you see why, and the order stays unbooked.
- **Booking the same order again** shows the AWB already issued; it never books twice.
- **"No answer from the carrier"** means the shipment may or may not have been created. Check the carrier portal for the order number first. The next attempt asks you to confirm before booking again.

### Audit log

`DATA_DIR/audit-YYYY-MM.jsonl` lists sign-ins (by password, passkey or recovery code), refused sign-ins, password changes, passkeys added or removed, new recovery codes, courier bookings and tests, and SMS tests. Each line is chained to the one before, so edits are detectable.
