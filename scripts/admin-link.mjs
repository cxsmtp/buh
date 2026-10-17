#!/usr/bin/env node
// The Admin Hub's private link, from the server (works in the published image, no code on disk):
//   podman exec beautifuluaehome node scripts/admin-link.mjs          what can be known about the link
//   podman exec beautifuluaehome node scripts/admin-link.mjs --new    make a new link and print it
//
// The shop keeps only a fingerprint (SHA-256) of the link, so the link itself can never be
// printed again: not by this script, not by the shop, not from a backup. A lost link is
// recovered by making a new one (--new). The old link and every browser let in through it
// (its "door" cookie) stop working at once, also in the running shop; the owner's admin
// sessions are not touched. The change is written to the audit log (never the link).
//
// The link is printed with NEXT_PUBLIC_APP_URL (the shop's address) when it is set, else as
// a path to put after the shop's address. Keep src/lib/server/adminLink.ts in step.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const make = args.includes('--new');
if (args.some((a) => a !== '--new') || args.includes('--help')) {
  console.log('Usage: node scripts/admin-link.mjs [--new]');
  process.exit(args.includes('--help') ? 0 : 2);
}

const dataDir = path.resolve(process.env.DATA_DIR || '.data');
const dbFile = path.join(dataDir, 'shop.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No shop database at ${dbFile}. Start the shop once first (it makes the first link and prints it in its log).`);
  process.exit(1);
}

const hash = (segment) => crypto.createHash('sha256').update(`buh-admin-link\n${segment}`).digest('base64url');
const base = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
const db = new Database(dbFile, { fileMustExist: true });
db.pragma('busy_timeout = 5000');

const row = db.prepare("SELECT data FROM kv WHERE key = 'admin:link'").get();
let current = null;
try {
  current = row ? JSON.parse(row.data) : null;
} catch {
  current = null;
}

if (!make) {
  db.close();
  if (current && current.hash) {
    console.log(`The Admin Hub has a private link, made ${current.createdAt || 'at some point'} (${current.via || 'unknown'}).`);
  } else {
    console.log('The Admin Hub has no private link yet: the shop makes one on its next start (printed in its log).');
  }
  console.log('');
  console.log('The shop keeps only a fingerprint of the link, so it cannot be shown again.');
  console.log('Lost it? Make a new one (the old link stops working at once):');
  console.log('  podman exec beautifuluaehome node scripts/admin-link.mjs --new');
  process.exit(0);
}

const segment = crypto.randomBytes(24).toString('base64url');
const now = new Date().toISOString();
const record = { hash: hash(segment), version: crypto.randomBytes(9).toString('base64url'), createdAt: now, via: 'script' };
const put = db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
db.transaction(() => {
  put.run('admin:link', JSON.stringify(record), now);
  put.run('admin:link-reveal', 'null', now);
  // The hub says "this is your private link: bookmark it" when it is next opened.
  put.run('admin:link-notice', JSON.stringify({ v: record.version, reason: 'new' }), now);
})();
db.close();
audit('admin.link_changed', { via: 'script' });

const link = base ? `${base}/${segment}` : `/${segment}`;
console.log('');
console.log('==================================================================');
console.log('  Beautiful UAE Home — a new private Admin Hub link');
console.log(`  Admin link: ${link}`);
if (!base) console.log("  (put your shop's address in front, e.g. https://yourshop.ae/…)");
console.log('  The old link no longer works. Open this one on your phone and');
console.log('  laptop and bookmark it. It is shown only this once.');
console.log('==================================================================');
console.log('');

/** Append to the shop's tamper-evident audit log (the same chain as src/lib/server/audit.ts). */
function audit(action, details) {
  try {
    const keyFile = path.join(dataDir, 'audit.key');
    let key;
    try {
      key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url');
    } catch {
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
    }
    const file = path.join(dataDir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
    let prev = 'genesis';
    let seq = 0;
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          prev = entry.mac;
          seq = entry.seq;
          break;
        } catch {
          // torn line: keep looking backwards
        }
      }
    }
    const body = { seq: seq + 1, id: crypto.randomUUID(), at: new Date().toISOString(), action, details, prev };
    const canonical = (v) =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(',')}]`
        : v && typeof v === 'object'
          ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
          : JSON.stringify(v ?? null);
    const mac = crypto.createHmac('sha256', key).update(prev).update('\n').update(canonical(body)).digest('base64url');
    fs.appendFileSync(file, `${JSON.stringify({ ...body, mac })}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`(The audit log could not be written: ${err instanceof Error ? err.message : String(err)})`);
  }
}
