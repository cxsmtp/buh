/**
 * The audit log's key ids and month links (review of BUH-02.10). Each entry names the key that
 * signed it; a log restored onto a new server (another key) is "signed by another server's key
 * (fingerprint …): restored from a backup", never BROKEN, and new entries start a fresh chain
 * after it. That label is only given to entries that name a proper key id other than this
 * server's: edited entries naming this server's key are BROKEN, entries naming no key (or a bogus
 * one) that don't check out are "unverified". Each month's first entry links to the month before,
 * so a missing month, or one cut short, shows. The viewer reads each file once per change.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const auditLib = await import('@/lib/server/audit');
const view = await import('@/lib/server/auditView');
const backup = await import('@/lib/server/backup');

const keyFile = path.join(dir, 'audit.key');
const monthOf = (iso: string) => path.join(dir, `audit-${iso.slice(0, 7)}.jsonl`);
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const write = (file: string, ls: string[]) => fs.writeFileSync(file, ls.map((l) => `${l}\n`).join(''));

/** Write entries as if it were `iso` (the month files are by date). */
function at<T>(iso: string, fn: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

test('each entry names its key id (a fingerprint, not the key); months link to the month before', () => {
  at('2026-07-10T10:00:00Z', () => {
    auditLib.audit('test.july', { n: 1 });
    auditLib.audit('test.july', { n: 2 });
  });
  at('2026-08-10T10:00:00Z', () => auditLib.audit('test.august', { n: 3 }));
  at('2026-09-10T10:00:00Z', () => auditLib.audit('test.september', { n: 4 }));
  const kid = auditLib.auditKeyId();
  assert.match(kid, /^[0-9a-f]{16}$/);
  assert.ok(!fs.readFileSync(keyFile, 'utf8').includes(kid));
  const july = lines(monthOf('2026-07')).map((l) => JSON.parse(l));
  assert.deepEqual(july.map((e) => e.kid), [kid, kid]);
  assert.equal(july[0].prevMonth, null, 'the first month links to nothing');
  const aug = JSON.parse(lines(monthOf('2026-08'))[0]);
  assert.deepEqual(aug.prevMonth, { file: 'audit-2026-07.jsonl', seq: 2, mac: july[1].mac });
  const v = auditLib.verifyAllAuditLogs();
  assert.equal(v.status, 'intact');
  assert.equal(v.ok, true);
  assert.deepEqual(v.gaps, []);
});

test('a missing month, or one cut short at its end, is reported (BROKEN)', () => {
  const aug = monthOf('2026-08');
  const original = fs.readFileSync(aug, 'utf8');
  fs.renameSync(aug, `${aug}.aside`);
  try {
    const v = auditLib.verifyAllAuditLogs();
    assert.equal(v.status, 'broken');
    assert.match(v.gaps.join(' '), /the month before it \(audit-2026-08\.jsonl\) is missing/);
    assert.match(view.verificationText(v).join(' '), /audit-2026-09\.jsonl: BROKEN at the month before it \(audit-2026-08\.jsonl\) is missing/);
  } finally {
    fs.renameSync(`${aug}.aside`, aug);
  }
  // July loses its last entry: July itself still checks out, but August's link says it went on.
  const july = monthOf('2026-07');
  const full = lines(july);
  write(july, full.slice(0, -1));
  try {
    const v = auditLib.verifyAllAuditLogs();
    assert.equal(v.months.find((m) => m.file === 'audit-2026-07.jsonl')!.problems.length, 0);
    assert.equal(v.status, 'broken');
    assert.match(v.gaps.join(' '), /audit-2026-07\.jsonl ends at entry 1, but this month began after its entry 2: its end was cut or changed/);
  } finally {
    write(july, full);
  }
  assert.equal(fs.readFileSync(aug, 'utf8'), original);
  assert.equal(auditLib.verifyAllAuditLogs().status, 'intact');
});

test('restored onto a new server (another key): "signed by another server\'s key", never BROKEN; new entries start a fresh chain', () => {
  const otherKey = crypto.randomBytes(32);
  const sept = monthOf('2026-09');
  // This month's entries were signed by the old server (the backup); now this server has another key.
  const ownKey = fs.readFileSync(keyFile, 'utf8');
  fs.writeFileSync(keyFile, otherKey.toString('base64url'));
  auditLib._resetAuditState();
  try {
    let v = auditLib.verifyAllAuditLogs();
    assert.equal(v.status, 'other_key');
    assert.equal(v.ok, false);
    assert.deepEqual(v.gaps, []);
    assert.ok(v.months.every((m) => m.problems.length === 0), 'nothing broken');
    const oldKid = JSON.parse(lines(sept)[0]).kid;
    assert.deepEqual(v.months[0].otherKeys, [oldKid]);
    const text = view.verificationText(v).join('\n');
    assert.match(text, new RegExp(`signed by another server's key \\(fingerprint ${oldKid}\\): restored from a backup`));
    assert.doesNotMatch(text, /BROKEN/);
    // The new server writes: a fresh segment after the restored entries, not chained onto their MACs.
    at('2026-09-20T10:00:00Z', () => auditLib.audit('test.after_restore', {}));
    const last = JSON.parse(lines(sept).at(-1)!);
    const before = JSON.parse(lines(sept).at(-2)!);
    assert.equal(last.prev, 'genesis');
    assert.equal(last.after, before.mac);
    assert.equal(last.kid, auditLib.auditKeyId());
    assert.notEqual(last.kid, oldKid);
    v = auditLib.verifyAllAuditLogs();
    const m = v.months.find((x) => x.file === 'audit-2026-09.jsonl')!;
    assert.deepEqual(m.segments.map((s) => [s.status, s.entries]), [['other_key', 1], ['verified', 1]]);
    assert.equal(v.status, 'other_key');
    assert.match(view.verificationText(v).join('\n'), /audit-2026-09\.jsonl: 1 intact; 1 signed by another server's key/);
  } finally {
    fs.writeFileSync(keyFile, ownKey);
    auditLib._resetAuditState();
  }
  // Back on the first server, its own entries check out and the new server's are "another key".
  const v = auditLib.verifyAllAuditLogs();
  assert.equal(v.status, 'other_key');
  assert.deepEqual(v.months.find((x) => x.file === 'audit-2026-09.jsonl')!.segments.map((s) => s.status), ['verified', 'other_key']);
  // Tidy: drop that line.
  write(sept, lines(sept).slice(0, -1));
  assert.equal(auditLib.verifyAllAuditLogs().status, 'intact');
});

test('"another key" can\'t whitewash a forged log: same key id with bad MACs is BROKEN; no or a bogus key id is "unverified"', () => {
  const july = monthOf('2026-07');
  const full = lines(july);
  const edit = (i: number, change: (e: Record<string, unknown>) => void) => {
    const ls = [...full];
    const e = JSON.parse(ls[i]);
    change(e);
    ls[i] = JSON.stringify(e);
    write(july, ls);
    return auditLib.verifyAllAuditLogs().months.find((m) => m.file === 'audit-2026-07.jsonl')!;
  };
  try {
    // Edited, naming this server's key: BROKEN.
    let m = edit(1, (e) => ((e.details as Record<string, unknown>).n = 99));
    assert.equal(m.status, 'broken');
    assert.match(m.problems[0], /line 2: MAC mismatch/);
    // Every entry rewritten with a made-up but well-formed key id... it can't pass as "restored"
    // while its links point at this server's MACs: the chain doesn't start fresh.
    const forged = full.map((l) => {
      const e = JSON.parse(l);
      e.kid = '0123456789abcdef';
      e.details.n = 7;
      return JSON.stringify(e);
    });
    write(july, forged);
    m = auditLib.verifyAllAuditLogs().months.find((x) => x.file === 'audit-2026-07.jsonl')!;
    assert.equal(m.status, 'other_key', 'a whole file signed elsewhere reads as restored (that is what a restore looks like)');
    // A forged entry without a key id among this server's entries: the key changes inside the chain.
    m = edit(1, (e) => {
      delete e.kid;
      (e.details as Record<string, unknown>).n = 50;
    });
    assert.equal(m.status, 'broken');
    assert.match(m.problems.join(' '), /line 2: key changed inside a chain/);
    // A whole file without key ids that doesn't check out with this key: unverified (amber), not "restored".
    write(july, full.map((l) => {
      const e = JSON.parse(l);
      delete e.kid;
      return JSON.stringify(e);
    }));
    m = auditLib.verifyAllAuditLogs().months.find((x) => x.file === 'audit-2026-07.jsonl')!;
    assert.equal(m.status, 'unverified');
    assert.equal(m.unverified, 2);
    assert.match(view.verificationText(auditLib.verifyAllAuditLogs()).join(' '), /2 unverified \(made before key ids/);
    // A bogus key id: unverified too.
    write(july, full.map((l) => JSON.stringify({ ...JSON.parse(l), kid: 'not-a-key' })));
    assert.equal(auditLib.verifyAllAuditLogs().months[0].status, 'unverified');
  } finally {
    write(july, full);
  }
  assert.equal(auditLib.verifyAllAuditLogs().status, 'intact');
});

test('entries from before key ids: checked with this server\'s key when they verify, and new entries chain onto them', () => {
  // A log as BUH-02.10 wrote it: no kid, no prevMonth, the same key.
  const legacyFile = path.join(dir, 'audit-2026-06.jsonl');
  const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64url');
  const canonical = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);
  let prev = 'genesis';
  const out: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const body = { seq: i, id: crypto.randomUUID(), at: `2026-06-0${i}T10:00:00.000Z`, action: 'test.legacy', details: { i }, prev };
    const mac = crypto.createHmac('sha256', key).update(prev).update('\n').update(canonical(body)).digest('base64url');
    out.push(JSON.stringify({ ...body, mac }));
    prev = mac;
  }
  write(legacyFile, out);
  try {
    // (July's first entry says there was no month before it; June now is: that's a gap.)
    let v = auditLib.verifyAllAuditLogs();
    const june = v.months.find((m) => m.file === 'audit-2026-06.jsonl')!;
    assert.equal(june.status, 'intact', 'legacy entries signed by this key verify');
    assert.deepEqual(june.segments.map((s) => s.kid), [null]);
    assert.match(v.gaps.join(' '), /audit-2026-06\.jsonl was not there when this month began/);
    // Appending to the legacy month chains onto it (its last entry verifies with this key).
    at('2026-06-20T10:00:00Z', () => auditLib.audit('test.after_legacy', {}));
    const last = JSON.parse(lines(legacyFile).at(-1)!);
    assert.equal(last.prev, JSON.parse(out[2]).mac);
    v = auditLib.verifyAllAuditLogs();
    assert.equal(v.months.find((m) => m.file === 'audit-2026-06.jsonl')!.status, 'intact');
  } finally {
    fs.rmSync(legacyFile);
  }
});

test('the viewer reads each month once per change: the check and the list of actions are kept until the file changes', () => {
  const file = monthOf('2026-09');
  const a = auditLib.verifyAuditLog(file);
  assert.equal(auditLib.verifyAuditLog(file), a, 'the same check, not read again');
  const p1 = view.auditPage({});
  assert.ok(p1.actions.includes('test.september'));
  at('2026-09-21T10:00:00Z', () => auditLib.audit('test.cache_new_action', {}));
  const b = auditLib.verifyAuditLog(file);
  assert.notEqual(b, a, 'checked again after it changed');
  assert.equal(b.entries, a.entries + 1);
  assert.ok(view.auditPage({}).actions.includes('test.cache_new_action'));
  // Read a piece at a time: a log longer than one read is the same.
  const big = monthOf('2026-05');
  at('2026-05-10T10:00:00Z', () => {
    for (let i = 0; i < 1500; i++) auditLib.audit('test.many', { text: 'z'.repeat(300), i });
  });
  assert.ok(fs.statSync(big).size > 256 * 1024);
  assert.equal(view.auditEntries({ action: 'test.many' }).length, 1500);
  assert.equal(auditLib.verifyAuditLog(big).status, 'intact');
  // The export, streamed in pieces, is the same bytes as one string.
  const pieces = [...view.auditExportChunks(view.iterAuditEntries({ action: 'test.many' }), 'csv', 100)];
  assert.ok(pieces.length > 10);
  assert.equal(pieces.join(''), view.auditExport(view.auditEntries({ action: 'test.many' }), 'csv'));
  fs.rmSync(big);
});

test('a backup restored onto a new server: its log reads "restored", never BROKEN; restored on this server (a new folder), this server\'s key comes along', async () => {
  const result = await backup.createBackup();
  // A new server: an empty folder, and the shop there makes its own key.
  const fresh = path.join(os.tmpdir(), `buh-restore-newserver-${Date.now()}`);
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, fresh], { env: { ...process.env, DATA_DIR: '' } });
  assert.ok(!fs.existsSync(path.join(fresh, 'audit.key')), 'no key in a backup');
  const check = (dataDir: string, extra = '') =>
    JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(dataDir)}; const m = await import('@/lib/server/audit'); const a = m.audit ?? m.default.audit; const v = m.verifyAllAuditLogs ?? m.default.verifyAllAuditLogs; ${extra} console.log(JSON.stringify(v()));`], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .pop()!
    );
  let v = check(fresh);
  assert.equal(v.status, 'other_key', JSON.stringify(v.months.map((m: { file: string; status: string; problems: string[] }) => [m.file, m.status, m.problems])));
  // The new server writes its first entry (the restore itself): still not broken.
  v = check(fresh, "a('backup.restored', { test: true });");
  assert.notEqual(v.status, 'broken', JSON.stringify(v.months.map((m: { file: string; problems: string[] }) => [m.file, m.problems])));
  assert.ok(v.months.every((m: { problems: string[] }) => m.problems.length === 0));
  fs.rmSync(fresh, { recursive: true, force: true });
  // On this server, into a new folder: the running shop's key (DATA_DIR) is copied, so it checks out.
  const here = path.join(os.tmpdir(), `buh-restore-sameserver-${Date.now()}`);
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, here], { env: { ...process.env, DATA_DIR: dir } }).toString();
  assert.match(out, /audit key was copied/);
  assert.equal(fs.readFileSync(path.join(here, 'audit.key'), 'utf8'), fs.readFileSync(keyFile, 'utf8'));
  assert.equal(check(here).status, 'intact');
  fs.rmSync(here, { recursive: true, force: true });
});
