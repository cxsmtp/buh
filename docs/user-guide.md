# User guide

## For customers: placing an order

1. Choose a set, a bed size and a colour, then **Add to Bag** and **Proceed to Checkout**.
2. **Verify your UAE mobile.** Type the number (50 123 4567, 050…, +971… all work) and tap **Send code**. Enter the 6-digit code from the SMS; it is checked as soon as the sixth digit is in. Pasting the code or using the phone's autofill works too.
   - The code is valid for 10 minutes, and a new one can be requested after 30 seconds.
   - After 5 wrong tries the code stops working; request a new one.
   - **Outside the UAE?** As soon as a non-UAE number is typed, checkout shows **Email orders@…**, which opens an email with the bag already listed.
   - **SMS not arriving?** If the shop's SMS service is down, checkout says so and offers the shop's email.
3. Fill in the delivery address (or **Use My GPS**), choose Cash on Delivery or bank transfer (with an optional receipt screenshot or PDF), and **Confirm & Raise Order**. The button stays locked until the phone is verified.
4. **Track Order:** enter the order number (shown on the confirmation and pre-filled on the same phone) and the mobile number used for the order.
- The bag is kept if the page is reloaded. Prices and stock are always checked by the shop when the order is placed.

## For the owner: the Admin Hub

### First sign-in

- **Docker / PM2:** the first start prints a one-time password in the log (`docker logs buhome-uae` or `pm2 logs buhome-app`).
- Sign in from **Admin Hub** with that email and password, then choose your own password: at least 12 characters, with at least 5 different characters.
- Lost the password? Stop the app, delete `admin.json` from `DATA_DIR`, and start it again. A new one-time password is printed. You can also set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`).
- 5 wrong passwords from one place pause sign-in there for 15 minutes; try again later or from another network. **Sign out** signs you out on every device.
- The build version (BUH-xx.xx.xx) shows next to the hub's title.

### Orders

New orders appear under **Orders & Dispatches** (the list refreshes every minute). For each order:

- **Confirm & Assign Courier** books Jeebly or Eco Express and prints the label.
- **Mark dispatched**, then **Out for delivery** or **Mark delivered**, as the parcel moves.
- **Bank transfers:**
  - **View receipt** opens what the customer uploaded.
  - **Mark payment received** once the money is in the account.
- **Cancel order** returns the items to stock. It cannot be undone.

Every change is recorded with who made it and when.

### Inventory

**Inventory Stock** lists every product. You can change the price and stock right there (**Save**), and **Visible / Hidden** shows or hides a product in the shop. **+ Add Bedding Set** creates a new one; its photos are stored on the server.

### Customers

**Customers & CRM** is built from the orders: one line per phone number, with the number of orders and the total spent.

### Bank details

Under **🎨 Logo & Marquee → Bank transfer details**. Customers paying by transfer see exactly these at checkout: check the IBAN before going live.

### Backups

The line at the top of the Admin Hub shows when the last backup ran:

- **green:** recent and emailed;
- **amber:** taken but not emailed (check the `SMTP_*` settings);
- **red:** failed or overdue.

**Back up now** runs one immediately. Backups run every 12 hours on their own. Restoring: see HOSTINGER_DEPLOYMENT_GUIDE.md.

### SMS & Real OTP

Enter the gateway's details, tap **Send test** to try it on your own mobile, then **Save Gateway Credentials**. Checkout then sends codes through it (a gateway set in `.env.production` takes priority). Keys are kept on the server and never shown again: leave a key field blank to keep the saved one. Webhook and Infobip URLs must be public https addresses.

### Couriers

Enter the Jeebly and Eco Express keys and use **Test connection**. Keys are kept on the server and never shown again: leave a key field blank to keep the saved one.

- **Sandbox mode** gives simulated AWBs, labelled as such.
- **Live mode** books with the carrier. If the carrier refuses, you see why, and the order stays unbooked.
- **Booking the same order again** shows the AWB already issued; it never books twice.
- **"No answer from the carrier"** means the shipment may or may not have been created. Check the carrier portal for the order number first. The next attempt asks you to confirm before booking again.

### Audit log

`DATA_DIR/audit-YYYY-MM.jsonl` lists sign-ins, refused sign-ins, password changes, courier bookings and tests, and SMS tests. Each line is chained to the one before, so edits are detectable.
