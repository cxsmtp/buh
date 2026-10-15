# Beautiful UAE Home

**Hand-block and machine-printed bed linen, sold online across all seven Emirates.** A storefront with exact UAE mattress sizing, Cash on Delivery and bank transfer, plus an Admin Hub for orders, Jeebly and Eco Express couriers, inventory, customers and branding.

| You get | How |
| --- | --- |
| **Orders reach you** | Every order is stored on the server with prices and stock checked there, and appears in the Admin Hub: book the courier, follow it to delivery, confirm bank transfers, cancel (stock returns). |
| **Backed up every 12 hours** | The shop emails itself to you: the full database, Excel-ready CSVs of orders and customers, and receipts, optionally encrypted. Status and **Back up now** in the Admin Hub; tested restore. |
| **Verified orders only** | Customers confirm their UAE mobile with a 6-digit SMS code (through the shop's SMS gateway or Firebase Phone Auth) before they can order. Other countries are invited to email the shop instead. |
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

**Production:** a Hostinger KVM VPS with Docker Compose. The shop runs behind Caddy, which provides automatic HTTPS. Step by step: [HOSTINGER_DEPLOYMENT_GUIDE.md](HOSTINGER_DEPLOYMENT_GUIDE.md).

```
docker compose pull app && docker compose up -d
```

The image `ghcr.io/cxsmtp/buh:latest` is built, tested and published from main. To try it on your own computer with Podman on Windows, run `scripts\run-local-podman.bat` (test mode, http://localhost:3000).

## Configure

Copy `.env.production.example` to `.env.production`. The settings that matter most:

- **`DOMAIN`, `ACME_EMAIL`:** for the automatic HTTPS certificate.
- The SMS gateway, couriers, bank details and branding are set in the Admin Hub.
- **`NEXT_PUBLIC_SUPPORT_EMAIL`:** shown to customers with non-UAE numbers.
- **Backup email (`SMTP_*`, `BACKUP_EMAIL`, `BACKUP_PASSPHRASE`):** where the 12-hourly backups go.
- **`DATA_DIR`:** the database, photos, receipts, backups and audit log (a Docker volume in production).
- **`TRUST_PROXY=1`:** only behind nginx.

Everything an owner does in the shop: [docs/user-guide.md](docs/user-guide.md).

## Develop

```
npm test
```

Runs unit and end-to-end tests; the end-to-end ones need `npm run build` first. Also: `npm run lint`, `npm run typecheck`, `npm run test:load` (benchmark), and `npm run hash-password` (makes `ADMIN_PASSWORD_HASH`). Working rules: [CLAUDE.md](CLAUDE.md). Changes: [CHANGELOG.md](CHANGELOG.md).
