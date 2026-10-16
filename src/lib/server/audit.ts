import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from './dataDir';
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
      details: redact(details),
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

export function verifyAuditLog(file = monthFile()): { ok: boolean; entries: number; problems: string[] } {
  const problems: string[] = [];
  let prev = 'genesis';
  let expectedSeq = 1;
  let entries = 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: true, entries: 0, problems };
  }
  for (const [i, line] of text.split('\n').filter(Boolean).entries()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: unreadable`);
      continue;
    }
    const { mac, ...body } = entry;
    if (body.seq !== expectedSeq) problems.push(`line ${i + 1}: sequence gap`);
    if (body.prev !== prev) problems.push(`line ${i + 1}: chain broken`);
    if (macOf(body, String(body.prev)) !== mac) problems.push(`line ${i + 1}: MAC mismatch`);
    prev = String(mac);
    expectedSeq = Number(body.seq) + 1;
    entries++;
  }
  return { ok: problems.length === 0, entries, problems };
}

/** Test hook: forget cached state so a new DATA_DIR is picked up. */
export function _resetAuditState() {
  key = null;
  lastMac = 'genesis';
  seq = 0;
  loadedFile = '';
}
