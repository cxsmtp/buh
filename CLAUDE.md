# Working on Beautiful UAE Home

Read AGENTS.md first: this is Next.js 16, check `node_modules/next/dist/docs/` before writing framework code.

- **Version log.** Every change merged to main bumps `version` in package.json (shown in the admin hub as
  BUH-xx.xx.xx) and adds an entry at the top of CHANGELOG.md, in the same pull request:
  - heading: `## BUH-xx.xx.xx — YYYY-MM-DD HH:MM UTC · [#NN](https://github.com/cxsmtp/buh/pull/NN)`;
  - 2–8 bullets: a bold lead-in, then one plain sentence on what changed for the people using it;
  - a **Status.** bullet with the benchmark, tests, dependency audit and security scan.
  Keep package-lock.json's version fields in step with package.json.
- **Tests:** `npm test` (unit + end-to-end; the end-to-end tests start the real build, so `npm run build` first).
  Every bug a person reports gets a test that fails before the fix and passes after it.
- **Benchmark every change, before and after.** Build main and the branch, then run `npm run test:load` against
  each, one after the other, with nothing else running. Record failed requests, requests per second and p50/p95
  per scenario. Explain or fix any run with failed requests or a slower tail before merging. Put the comparison
  in the pull request and a row in docs/status.md.
- **Never charge or ship twice.** Any action that moves money, stock or a courier booking is idempotent,
  checked against the source of truth (the carrier, the payment provider), and written to the audit log before
  it is reported as done. Never invent a tracking number, payment reference or confirmation.
- **Every new API route checks permissions on the server** (`requireAdmin` in src/lib/server/guard.ts), reads its
  body with `readJsonBody` (size-capped) and validates fields against an allow-list. Errors go through
  `handleRouteError`, so nothing internal leaks.
- **Data lives on the server** (SQLite in `DATA_DIR/shop.db`, via src/lib/server/db.ts). Schema changes are a new
  numbered migration at the end of `MIGRATIONS`; never edit one that has shipped. Migrations only add (tables, columns,
  indexes): during an update the old and new versions share the database for a minute, and a rollback runs the old one. Money is computed in fils (AED × 100)
  on the server; never trust a price, total or phone number from the browser.
- **Backups are critical:** any new data (table, folder) must be included in `createBackup` and restored by
  scripts/restore-backup.mjs, with a test that restores it.
- **Secrets never reach the browser or the logs.** Use `logEvent` (redacts keys, masks phones and emails).
  Outbound URLs that a person can choose go through `assertPublicHttpsUrl` and `safeFetch`.
- **Look at every page change in a browser at phone (375 px) and desktop width**: no horizontal scroll, keyboard
  works.
- **Publish status every release:** a row in docs/status.md, honest when something could not run.
- **Docs to keep in step:** README.md (short), docs/user-guide.md, docs/security.md and
  HOSTINGER_DEPLOYMENT_GUIDE.md. Commands one line each.
- **Defaults are the safe, focused choice; "everything" is opt-in.**
- **The owner runs containers with Podman, not Docker.** Give `podman` commands in replies and docs (container
  `beautifuluaehome`, run with `-p 443:3000`; update: `podman pull ghcr.io/cxsmtp/buh:latest`, then stop, rm, re-run).
