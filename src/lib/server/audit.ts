import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dataDir, dataFile } from './dataDir';
import { inTransaction } from './db';
import { HttpError } from './http';
import { logEvent, redact } from './log';

/**
 * Tamper-evident audit log: append-only JSON lines, one file per month, each entry carrying an
 * HMAC over the previous entry's MAC and its own canonical body. Editing, removing or reordering
 * any line breaks the chain, which verifyAuditLog() reports.
 *
 * Each entry names the key that signed it (`kid`, a short fingerprint of the HMAC key; the key
 * itself never leaves the server). When the key changes (a backup restored onto a new server), the
 * next entry starts a fresh chain segment ("genesis", with `after` naming the last entry before
 * it) instead of chaining onto MACs this server can't check. A month's first entry records the
 * previous month's last entry (`prevMonth`), so a missing month, or one cut short, shows.
 */

let key: Buffer | null = null;
let keyId = '';
let loadedFile = '';

/** A key id: 16 hex characters. */
export const KEY_ID = /^[0-9a-f]{16}$/;

function auditKey(): Buffer {
  if (key) return key;
  const file = dataFile('audit.key');
  try {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
  } catch {
    key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(file, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
    } catch {
      key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
    }
  }
  keyId = crypto.createHash('sha256').update('buh-audit-key-id\n').update(key).digest('hex').slice(0, 16);
  return key;
}

/** This server's key id (a fingerprint: it can't be turned back into the key). */
export function auditKeyId(): string {
  auditKey();
  return keyId;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function macOf(body: Record<string, unknown>, prev: string): string {
  return crypto.createHmac('sha256', auditKey()).update(prev).update('\n').update(canonical(body)).digest('base64url');
}

function monthFile(date = new Date()): string {
  return dataFile(`audit-${date.toISOString().slice(0, 7)}.jsonl`);
}

/** The last readable entry of a file (read from its end, so a long log costs nothing), or null. */
export function lastEntryOf(file: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (let span = Math.min(size, 64 * 1024); span > 0; span = Math.min(size, span * 4)) {
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, size - span);
      const lines = buf.toString('utf8').split('\n');
      // The first piece may be cut in the middle (unless the whole file was read).
      const from = span === size ? 0 : 1;
      for (let i = lines.length - 1; i >= from; i--) {
        if (!lines[i]) continue;
        try {
          return JSON.parse(lines[i]);
        } catch {
          // torn line: keep looking backwards
        }
      }
      if (span === size) return null;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** What the next entry links to. */
interface Head {
  prev: string;
  seq: number;
  /** A new segment after an entry this server can't check: that entry's MAC. */
  after?: string;
  /** The first entry of a month: the previous month's last entry (null when there is none). */
  prevMonth?: { file: string; seq: number; mac: string } | null;
}

/** The chain head on disk (re-read each time, so restarts and other processes continue it). */
function headOf(file: string): Head {
  loadedFile = file;
  const last = lastEntryOf(file);
  if (!last) {
    const name = path.basename(file);
    const before = auditFiles().filter((f) => f < name).pop();
    const end = before ? lastEntryOf(dataFile(before)) : null;
    return { prev: 'genesis', seq: 0, prevMonth: before && end ? { file: before, seq: Number(end.seq), mac: String(end.mac) } : null };
  }
  const { mac, ...body } = last;
  const lastSeq = Number(body.seq) || 0;
  // Chained only onto an entry this server can check: its own key id, or an older entry (no key
  // id) that its key signed. Anything else (a restored log) starts a fresh segment.
  const ours = body.kid === auditKeyId() || (body.kid === undefined && macOf(body, String(body.prev)) === mac);
  return ours ? { prev: String(mac), seq: lastSeq } : { prev: 'genesis', seq: lastSeq, after: String(mac) };
}

/**
 * Fields kept as they are: who acted (the admin's sign-in email, or "stripe", "customer"…) and the
 * order number. The audit file is the owner's own record (0600, and only in encrypted backups), so
 * it must say exactly who did what to which order. Everything else is redacted as in the logs:
 * secrets by key name, customer phones and emails in free text.
 */
const VERBATIM = ['by', 'orderId'] as const;

/** A text the owner typed that may be long (an expense's note, before → after): kept up to 2,000 characters, masked the same way. */
const LONG_TEXT = { keys: new Set(['note']), max: 2000 };

function auditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out = redact(details, 0, LONG_TEXT) as Record<string, unknown>;
  for (const k of VERBATIM) {
    const v = details[k];
    if (typeof v === 'string') out[k] = v.replace(/\p{Cc}/gu, '').slice(0, 254);
  }
  return out;
}

/** Append an entry. Never throws; returns false when it could not be written (see logs). */
export function audit(action: string, details: Record<string, unknown> = {}): boolean {
  try {
    const head = headOf(monthFile());
    const body: Record<string, unknown> = {
      seq: head.seq + 1,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      details: auditDetails(details),
      kid: auditKeyId(),
      prev: head.prev,
      ...(head.after ? { after: head.after } : {}),
      ...(head.prevMonth !== undefined ? { prevMonth: head.prevMonth } : {}),
    };
    const mac = macOf(body, head.prev);
    fs.appendFileSync(loadedFile, `${JSON.stringify({ ...body, mac })}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    // Auditing must never take the shop down; say so loudly instead.
    logEvent('error', 'audit_write_failed', { action, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export type AuditStatus = 'intact' | 'other_key' | 'unverified' | 'broken';

export interface AuditSegment {
  /** The key id the entries name (null: made before key ids). */
  kid: string | null;
  firstLine: number;
  lastLine: number;
  entries: number;
  /** verified: this server's key checks every one; other_key: signed by another server (a restore); unverified: can't be checked; broken: tampered. */
  status: 'verified' | 'other_key' | 'unverified' | 'broken';
}

export interface AuditVerification {
  /** Every entry checked with this server's key, nothing broken. */
  ok: boolean;
  status: AuditStatus;
  entries: number;
  /** What is broken (edited, removed or reordered lines, a missing month): empty unless status is "broken". */
  problems: string[];
  segments: AuditSegment[];
  /** Key ids of other servers whose entries are here (a backup restored onto this one). */
  otherKeys: string[];
  /** Entries that can't be checked (made before key ids and not signed by this key, or naming no proper key). */
  unverified: number;
  /** Signed by another server's key (a restore) and otherwise in order. */
  otherKey?: boolean;
  /** The first entry's link to the month before (undefined: written before months were linked). */
  prevMonth?: { file: string; seq: number; mac: string } | null;
  /** The last entry's sequence number and MAC (what the next month's first entry links to). */
  lastSeq?: number;
  lastMac?: string;
}

/** Each line of a file, read a piece at a time (a long log is never one string in memory). */
export function* fileLines(file: string): Generator<string> {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(256 * 1024);
    let rest = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const lines = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = lines.pop() ?? '';
      yield* lines;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

/** Checked months, by file: checked again only when the file's size or time changes. */
const checked = new Map<string, { size: number; mtimeMs: number; ino: number; kid: string; result: AuditVerification }>();

function finish(v: Omit<AuditVerification, 'ok' | 'status' | 'otherKey'>): AuditVerification {
  const status: AuditStatus = v.problems.length ? 'broken' : v.unverified ? 'unverified' : v.otherKeys.length ? 'other_key' : 'intact';
  return { ...v, ok: status === 'intact', status, ...(status === 'other_key' ? { otherKey: true } : {}) };
}

/** Check one month's file (cached by its size and time, so the viewer reads it once per change). */
export function verifyAuditLog(file = monthFile()): AuditVerification {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return finish({ entries: 0, problems: [], segments: [], otherKeys: [], unverified: 0 });
  }
  const kid = auditKeyId();
  const hit = checked.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino && hit.kid === kid) return hit.result;
  const result = verifyLines(fileLines(file));
  checked.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, kid, result });
  return result;
}

function verifyLines(lines: Iterable<string>): AuditVerification {
  const current = auditKeyId();
  const problems: string[] = [];
  const segments: Array<AuditSegment & { macOk: number; macBad: number[] }> = [];
  let prevMac: string | null = null;
  let expectedSeq = 1;
  let entries = 0;
  let lineNo = 0;
  let prevMonth: AuditVerification['prevMonth'];
  let lastSeq: number | undefined;
  const note = (p: string) => {
    if (problems.length < 50) problems.push(p);
  };
  const start = (kid: string | null) => {
    segments.push({ kid, firstLine: lineNo, lastLine: lineNo, entries: 0, status: 'verified', macOk: 0, macBad: [] });
  };
  for (const line of lines) {
    lineNo++;
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      note(`line ${lineNo}: unreadable`);
      continue;
    }
    const { mac, ...body } = entry;
    const kid = body.kid === undefined ? null : String(body.kid);
    if (entries === 0 && 'prevMonth' in body) prevMonth = (body.prevMonth ?? null) as AuditVerification['prevMonth'];
    if (body.seq !== expectedSeq) note(`line ${lineNo}: sequence gap`);
    const seg = segments[segments.length - 1];
    if (prevMac === null || !seg) {
      if (body.prev !== 'genesis') note(`line ${lineNo}: chain broken`);
      start(kid);
    } else if (body.prev === 'genesis' && kid !== null) {
      // A fresh segment: only where the key changes, and it names the entry before it.
      if (body.after !== prevMac) note(`line ${lineNo}: chain broken`);
      else if (kid === seg.kid) note(`line ${lineNo}: chain restarted`);
      start(kid);
    } else {
      if (body.prev !== prevMac) note(`line ${lineNo}: chain broken`);
      if (kid !== seg.kid) {
        // Chained across a key change: only from an older entry (no key id) into this server's key.
        if (!(seg.kid === null && kid === current)) note(`line ${lineNo}: key changed inside a chain`);
        start(kid);
      }
    }
    const s = segments[segments.length - 1];
    if (macOf(body, String(body.prev)) === mac) s.macOk++;
    else {
      s.macBad.push(lineNo);
      if (kid === current) note(`line ${lineNo}: MAC mismatch`);
    }
    s.entries++;
    s.lastLine = lineNo;
    prevMac = String(mac);
    expectedSeq = Number(body.seq) + 1;
    lastSeq = Number(body.seq);
    entries++;
  }
  const otherKeys = new Set<string>();
  let unverified = 0;
  const out: AuditSegment[] = [];
  for (const { macOk, macBad, ...s } of segments) {
    if (s.kid === current || !macBad.length) {
      s.status = macBad.length ? 'broken' : 'verified';
    } else if (macOk) {
      // Some entries check out with this server's key and some don't: edited.
      s.status = 'broken';
      for (const l of macBad) note(`line ${l}: MAC mismatch`);
    } else if (s.kid !== null && KEY_ID.test(s.kid)) {
      s.status = 'other_key';
      otherKeys.add(s.kid);
    } else {
      // No key id (made before key ids) or no proper one: can't be checked here.
      s.status = 'unverified';
      unverified += s.entries;
    }
    out.push(s);
  }
  return finish({ entries, problems, segments: out, otherKeys: [...otherKeys], unverified, prevMonth, ...(prevMac !== null ? { lastSeq, lastMac: prevMac } : {}) });
}

/** The monthly audit files (audit-YYYY-MM.jsonl), oldest first. */
export function auditFiles(): string[] {
  return fs
    .readdirSync(dataDir())
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
}

export interface AuditLogVerification {
  ok: boolean;
  status: AuditStatus;
  entries: number;
  months: Array<AuditVerification & { file: string }>;
  /** Months missing or cut short, as far as the links between months tell. */
  gaps: string[];
  /** This server's key id. */
  keyId: string;
}

const RANK: Record<AuditStatus, number> = { intact: 0, other_key: 1, unverified: 2, broken: 3 };

/**
 * Every month's file checked, and the links between months (each month's first entry names the
 * last one of the month before): the whole log is intact only if each month is and none is missing.
 */
export function verifyAllAuditLogs(): AuditLogVerification {
  const files = auditFiles();
  const months = files.map((file) => ({ file, ...verifyAuditLog(dataFile(file)) }));
  const gaps: string[] = [];
  months.forEach((m, i) => {
    const link = m.prevMonth;
    if (link === undefined) return; // written before months were linked
    const gap = (text: string) => {
      gaps.push(text);
      Object.assign(m, { problems: [...m.problems, text], ok: false, status: 'broken', otherKey: undefined });
    };
    const earlier = files.slice(0, i);
    if (link === null) {
      if (earlier.length) gap(`${earlier.join(', ')} ${earlier.length === 1 ? 'was' : 'were'} not there when this month began`);
      return;
    }
    const before = months.find((x) => x.file === link.file);
    if (!before) return gap(`the month before it (${link.file}) is missing`);
    if (before.lastMac !== link.mac || before.lastSeq !== link.seq) gap(`${link.file} ends at entry ${before.lastSeq ?? 0}, but this month began after its entry ${link.seq}: its end was cut or changed`);
    const between = earlier.filter((f) => f > link.file);
    if (between.length) gap(`${between.join(', ')} ${between.length === 1 ? 'was' : 'were'} not there when this month began`);
  });
  const status = months.reduce<AuditStatus>((w, m) => (RANK[m.status] > RANK[w] ? m.status : w), 'intact');
  return { ok: status === 'intact', status, entries: months.reduce((n, m) => n + m.entries, 0), months, gaps, keyId: auditKeyId() };
}

/** Write an audit entry or refuse the change: 503, and the caller saves nothing. */
export function auditOrThrow(action: string, details: Record<string, unknown>): void {
  if (!audit(action, details)) throw new HttpError(503, 'The audit log could not be written, so nothing was changed. Please try again.');
}

/**
 * A transaction whose changes are audited before they count: each auditOrThrow() writes its entry
 * (or throws 503, and nothing is saved). The entry is written before COMMIT, so if the commit
 * itself then fails (the disk is full, the database is busy), a "rolled_back" entry follows it at
 * once: the audit log never claims a change the database doesn't have.
 */
export function auditedTransaction<T>(fn: (auditOrThrow: (action: string, details: Record<string, unknown>) => void) => T): T {
  const written: Array<{ action: string; details: Record<string, unknown> }> = [];
  const record = (action: string, details: Record<string, unknown>) => {
    auditOrThrow(action, details);
    written.push({ action, details });
  };
  try {
    return inTransaction(() => fn(record));
  } catch (err) {
    for (const w of written) {
      const ok = audit('audit.rolled_back', {
        action: w.action,
        ...(typeof w.details.orderId === 'string' ? { orderId: w.details.orderId } : {}),
        ...(typeof w.details.expenseId === 'string' ? { expenseId: w.details.expenseId } : {}),
        ...(typeof w.details.by === 'string' ? { by: w.details.by } : {}),
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      if (!ok) logEvent('error', 'audit_rollback_note_failed', { action: w.action });
    }
    throw err;
  }
}

/** Test hook: forget cached state so a new DATA_DIR (or a new key) is picked up. */
export function _resetAuditState() {
  key = null;
  keyId = '';
  loadedFile = '';
  checked.clear();
}
