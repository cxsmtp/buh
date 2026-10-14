# User guide

## For customers: placing an order

1. Choose a set, a bed size and a colour, then **Add to Bag** and **Proceed to Checkout**.
2. **Verify your UAE mobile.** Type the number (50 123 4567, 050…, +971… all work) and tap **Send code**. Enter the 6-digit code from the SMS; it is checked as soon as the sixth digit is in. Pasting the code or using the phone's autofill works too.
   - The code is valid for 10 minutes, and a new one can be requested after 30 seconds.
   - After 5 wrong tries the code stops working; request a new one.
   - **Outside the UAE?** As soon as a non-UAE number is typed, checkout shows **Email orders@…**, which opens an email with the bag already listed.
3. Fill in the delivery address (or **Use My GPS**), choose Cash on Delivery or bank transfer, and **Confirm & Raise Order**. The button stays locked until the phone is verified.

## For the owner: the Admin Hub

### First sign-in

- **Docker / PM2:** the first start prints a one-time password in the log (`docker logs buhome-uae` or `pm2 logs buhome-app`).
- Sign in from **Admin Hub** with that email and password, then choose your own password: at least 12 characters, with at least 5 different characters.
- Lost the password? Stop the app, delete `admin.json` from `DATA_DIR`, and start it again. A new one-time password is printed. You can also set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (from `npm run hash-password`).
- 5 wrong passwords lock sign-in for 15 minutes.
- The build version (BUH-xx.xx.xx) shows next to the hub's title.

### SMS & Real OTP

The live checkout uses the gateway in the server's environment (`.env.production`). The SMS tab is for trying a gateway: enter its details and tap **Send test**. Webhook and Infobip URLs must be public https addresses.

### Couriers

Enter the Jeebly and Eco Express keys and use **Test connection**.

- **Sandbox mode** gives simulated AWBs, labelled as such.
- **Live mode** books with the carrier. If the carrier refuses or is unreachable, you see why, and the order stays unbooked.

### Audit log

`DATA_DIR/audit-YYYY-MM.jsonl` lists sign-ins, refused sign-ins, password changes, courier bookings and tests, and SMS tests. Each line is chained to the one before, so edits are detectable.
