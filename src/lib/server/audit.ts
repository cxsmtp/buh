import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataDir, dataFile } from './dataDir';
import { inTransaction } from './db';
import { HttpError } from './http';
import { logEvent, redact } from './log';

/**
 * Tamper-evident audit log: append-only JSON lines, one file per month, each
 * entry carrying an HMAC over the previous entry's MAC and its own canonical
 * body. Editing, removing or reordering any line breaks the chain, which
 * verifyAuditLog() reports.
 */

let key: Buffer | null = null;
let lastMac = 'genesis';
let seq = 0;
let loadedFile = '';

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
  return key;
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

function resync(file: string) {
  // Pick up the chain head from disk, so restarts and other processes continue it.
  loadedFile = file;
  lastMac = 'genesis';
  seq = 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      lastMac = entry.mac;
      seq = entry.seq;
      return;
    } catch {
      // torn line: keep looking backwards
    }
  }
}

/**
 * Fields kept as they are: who acted (the admin's sign-in email, or "stripe", "customer"…) and the
 * order number. The audit file is the owner's own record (0600, and only in encrypted backups), so
 * it must say exactly who did what to which order. Everything else is redacted as in the logs:
 * secrets by key name, customer phones and emails in free text.
 */
const VERBATIM = ['by', 'orderId'] as const;

function auditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out = redact(details) as Record<string, unknown>;
  for (const k of VERBATIM) {
    const v = details[k];
    if (typeof v === 'string') out[k] = v.replace(/\p{Cc}/gu, '').slice(0, 254);
  }
  return out;
}

/** Append an entry. Never throws; returns false when it could not be written (see logs). */
export function audit(action: string, details: Record<string, unknown> = {}): boolean {
  try {
    // Re-read the chain head each time: another worker may have appended.
    resync(monthFile());
    const body = {
      seq: seq + 1,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      details: auditDetails(details),
      prev: lastMac,
    };
    const mac = macOf(body, lastMac);
    fs.appendFileSync(loadedFile, `${JSON.stringify({ ...body, mac })}\n`, { mode: 0o600 });
    lastMac = mac;
    seq = body.seq;
    return true;
  } catch (err) {
    // Auditing must never take the shop down; say so loudly instead.
    logEvent('error', 'audit_write_failed', { action, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  problems: string[];
  /**
   * Every entry's links (sequence, previous MAC) are intact but no MAC matches this server's key:
   * the log was signed by another server (a backup restored onto a new one). Not tampering, but it
   * can't be proven here either.
   */
  otherKey?: boolean;
}

export function verifyAuditLog(file = monthFile()): AuditVerification {
  const problems: string[] = [];
  let prev = 'genesis';
  let expectedSeq = 1;
  let entries = 0;
  let linkProblems = 0;
  let macProblems = 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: true, entries: 0, problems };
  }
  const note = (p: string) => {
    if (problems.length < 50) problems.push(p);
  };
  for (const [i, line] of text.split('\n').filter(Boolean).entries()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      note(`line ${i + 1}: unreadable`);
      linkProblems++;
      continue;
    }
    const { mac, ...body } = entry;
    if (body.seq !== expectedSeq) {
      note(`line ${i + 1}: sequence gap`);
      linkProblems++;
    }
    if (body.prev !== prev) {
      note(`line ${i + 1}: chain broken`);
      linkProblems++;
    }
    if (macOf(body, String(body.prev)) !== mac) {
      note(`line ${i + 1}: MAC mismatch`);
      macProblems++;
    }
    prev = String(mac);
    expectedSeq = Number(body.seq) + 1;
    entries++;
  }
  const otherKey = entries > 0 && linkProblems === 0 && macProblems === entries;
  return { ok: problems.length === 0, entries, problems, ...(otherKey ? { otherKey } : {}) };
}

/** The monthly audit files (audit-YYYY-MM.jsonl), oldest first. */
export function auditFiles(): string[] {
  return fs
    .readdirSync(dataDir())
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
}

/** Every month's file checked: the whole log is intact only if each one is. */
export function verifyAllAuditLogs(): { ok: boolean; entries: number; months: Array<AuditVerification & { file: string }> } {
  const months = auditFiles().map((file) => ({ file, ...verifyAuditLog(dataFile(file)) }));
  return { ok: months.every((m) => m.ok), entries: months.reduce((n, m) => n + m.entries, 0), months };
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

/** Test hook: forget cached state so a new DATA_DIR is picked up. */
export function _resetAuditState() {
  key = null;
  lastMac = 'genesis';
  seq = 0;
  loadedFile = '';
}
