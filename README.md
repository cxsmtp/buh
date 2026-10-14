# Beautiful UAE Home

**Hand-block and machine-printed bed linen, sold online across all seven Emirates.** A storefront with exact UAE mattress sizing, Cash on Delivery and bank transfer, plus an Admin Hub for orders, Jeebly and Eco Express couriers, inventory, customers and branding.

| You get | How |
| --- | --- |
| **Verified orders only** | Customers confirm their UAE mobile with a 6-digit SMS code before they can order. Other countries are invited to email the shop instead. |
| **An admin hub only you can open** | Server-checked sign-in with lockout, a one-time first password you replace at first sign-in, and an audit log of every sign-in and courier booking. |
| **Real courier bookings** | Jeebly and Eco Express AWBs come from the carrier. A failed booking says so; it never invents a tracking number. |
| **Safe by default** | Security headers on every page, size-capped and validated API input, limits against SMS-pumping fraud, and no secrets in the browser or the logs ([security](docs/security.md)). |
| **Fast** | The storefront serves ~800 requests/s on 4 vCPU ([status](docs/status.md)). |

## Run it

Node 20+:

```
npm ci && npm run dev
```

Open <http://localhost:3000>. The terminal prints the first admin password once; sign in from **Admin Hub** and choose your own. Without an SMS gateway, checkout runs in test mode and shows the code on screen.

Production on a VPS (PM2 + nginx) or Docker: [HOSTINGER_DEPLOYMENT_GUIDE.md](HOSTINGER_DEPLOYMENT_GUIDE.md).

```
docker compose up -d --build
```

## Configure

Copy `.env.production.example` to `.env.production`. The settings that matter most:

- **SMS gateway** for phone codes: Twilio, Infobip or your own https webhook.
- **`NEXT_PUBLIC_SUPPORT_EMAIL`:** shown to customers with non-UAE numbers.
- **`DATA_DIR`:** the admin account, session key and audit log. Back it up.
- **`TRUST_PROXY=1`:** only behind nginx.

Everything an owner does in the shop: [docs/user-guide.md](docs/user-guide.md).

## Develop

```
npm test
```

Runs unit and end-to-end tests; the end-to-end ones need `npm run build` first. Also: `npm run lint`, `npm run typecheck`, `npm run test:load` (benchmark), and `npm run hash-password` (makes `ADMIN_PASSWORD_HASH`). Working rules: [CLAUDE.md](CLAUDE.md). Changes: [CHANGELOG.md](CHANGELOG.md).
