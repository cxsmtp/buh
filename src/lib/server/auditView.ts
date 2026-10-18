import fs from 'node:fs';
import { dubaiDateOf } from '@/lib/reportPeriods';
import { audit, auditFiles, auditOrThrow, fileLines, verifyAllAuditLogs, type AuditLogVerification } from './audit';
import { takeExportLock } from './exportLock';
import { logEvent } from './log';
import { csvHead, csvRow } from './csv';
import { dataFile } from './dataDir';

/**
 * Reading the audit log back (Money → Audit log, and the accountant's export): newest first,
 * filtered by UAE date, action, who and order number, a page at a time, with the chain check of
 * every month. Read-only: nothing here writes to it. The entries are already redacted (secrets by
 * name, customers' phones and emails masked) when they are written (src/lib/server/audit.ts).
 * Files are read a piece at a time; the list of actions and each month's check are kept until
 * the file changes (its size or time).
 */

export interface AuditEntry {
  seq: number;
  id: string;
  at: string;
  action: string;
  details: Record<string, unknown>;
  prev: string;
  mac: string;
  /** Which month's file, and its line (1-based), for "where it breaks". */
  file: string;
  line: number;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  action?: string;
  who?: string;
  order?: string;
}

/** Who did it: the admin's email, or "stripe", "customer", "script"… */
export function whoOf(e: { details: Record<string, unknown> }): string {
  const d = e.details;
  for (const k of ['by', 'email', 'via', 'from']) if (typeof d[k] === 'string' && d[k]) return d[k] as string;
  return '';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The month files that can hold entries from..to. Files are by UTC month and the UAE is 4 hours
 * ahead, so an entry of UAE date D is in D's month or, in the first hours of a month, the one before.
 */
function filesFor(from?: string, to?: string): string[] {
  const first = from ? new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7) : '';
  const last = to ? to.slice(0, 7) : '';
  return auditFiles().filter((f) => {
    const month = f.slice(6, 13);
    return (!first || month >= first) && (!last || month <= last);
  });
}

/** Every entry matching the query, oldest first, read a line at a time (unreadable lines are skipped here; the chain check reports them). */
export function* iterAuditEntries(q: AuditQuery = {}): Generator<AuditEntry> {
  const from = q.from && DATE.test(q.from) ? q.from : undefined;
  const to = q.to && DATE.test(q.to) ? q.to : undefined;
  const action = (q.action ?? '').trim().toLowerCase().slice(0, 80);
  const who = (q.who ?? '').trim().toLowerCase().slice(0, 120);
  const order = (q.order ?? '').trim().toUpperCase().slice(0, 60);
  for (const file of filesFor(from, to)) {
    let line = 0;
    for (const text of fileLines(dataFile(file))) {
      line++;
      if (!text) continue;
      let e: AuditEntry;
      try {
        e = { ...JSON.parse(text), file, line };
      } catch {
        continue;
      }
      if (typeof e.at !== 'string' || typeof e.action !== 'string') continue;
      e.details = e.details && typeof e.details === 'object' ? e.details : {};
      const day = dubaiDateOf(e.at);
      if (from && day < from) continue;
      if (to && day > to) continue;
      // An action prefix ("expense." or "payment") or the exact action.
      if (action && !e.action.toLowerCase().startsWith(action)) continue;
      if (who && !whoOf(e).toLowerCase().includes(who)) continue;
      if (order) {
        const id = typeof e.details.orderId === 'string' ? e.details.orderId.toUpperCase() : '';
        const expense = typeof e.details.expenseId === 'string' ? e.details.expenseId.toUpperCase() : '';
        if (!id.includes(order) && !expense.includes(order)) continue;
      }
      yield e;
    }
  }
}

/** Every entry matching the query, oldest first. */
export function auditEntries(q: AuditQuery = {}): AuditEntry[] {
  return [...iterAuditEntries(q)];
}

const actionCache = new Map<string, { size: number; mtimeMs: number; ino: number; actions: Set<string> }>();

/** Every action in the log (for the filter): each file read once per change. */
export function auditActions(): string[] {
  const all = new Set<string>();
  for (const file of auditFiles()) {
    const full = dataFile(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    let hit = actionCache.get(full);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs || hit.ino !== st.ino) {
      const actions = new Set<string>();
      for (const text of fileLines(full)) {
        // The action without parsing every line in full.
        const m = /"action":"((?:[^"\\]|\\.)*)"/.exec(text);
        if (m) actions.add(m[1]);
      }
      hit = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, actions };
      actionCache.set(full, hit);
    }
    for (const a of hit.actions) all.add(a);
  }
  return [...all].sort();
}

export interface AuditPage {
  entries: Array<Omit<AuditEntry, 'prev' | 'mac'> & { who: string }>;
  total: number;
  page: number;
  pages: number;
  actions: string[];
  verification: AuditLogVerification;
}

/** One page (50 by default), newest first, with the list of actions for the filter and the chain check. */
export function auditPage(q: AuditQuery & { page?: number; pageSize?: number } = {}): AuditPage {
  const all = auditEntries(q).reverse();
  const size = Math.min(Math.max(10, Math.floor(q.pageSize ?? 50)), 200);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const page = Math.min(Math.max(1, Math.floor(q.page ?? 1)), pages);
  return {
    entries: all.slice((page - 1) * size, page * size).map(({ prev: _p, mac: _m, ...e }) => {
      void _p;
      void _m;
      return { ...e, who: whoOf(e) };
    }),
    total: all.length,
    page,
    pages,
    actions: auditActions(),
    verification: verifyAllAuditLogs(),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The chain check in words, for the hub and the accountant's README. */
export function verificationText(v: AuditLogVerification): string[] {
  if (!v.months.length) return ['The audit log is empty.'];
  if (v.ok) return [`The log is intact: ${v.entries} entries in ${plural(v.months.length, 'month')}, every entry's signature and link to the one before checked.`];
  const lines: string[] = [];
  for (const m of v.months) {
    if (m.status === 'broken') {
      lines.push(`${m.file}: BROKEN at ${m.problems[0]}${m.problems.length > 1 ? ` (and ${plural(m.problems.length - 1, 'more problem')})` : ''}.`);
      continue;
    }
    const mine = m.segments.filter((s) => s.status === 'verified').reduce((n, s) => n + s.entries, 0);
    const parts: string[] = [];
    if (mine) parts.push(`${mine} intact`);
    for (const kid of m.otherKeys) {
      const n = m.segments.filter((s) => s.kid === kid).reduce((k, s) => k + s.entries, 0);
      parts.push(`${n} signed by another server's key (fingerprint ${kid}): restored from a backup, in order, but only that server can check their signatures`);
    }
    if (m.unverified) parts.push(`${m.unverified} unverified (made before key ids, and not signed by this server's key)`);
    lines.push(`${m.file}: ${parts.length ? parts.join('; ') : 'empty'}.`);
  }
  return lines;
}

/** One line of an export: Excel-safe CSV, or the original JSON line (signatures included). */
function exportLine(e: AuditEntry, format: 'csv' | 'jsonl'): string {
  if (format === 'jsonl') {
    const { file: _f, line: _l, ...rest } = e;
    void _f;
    void _l;
    return `${JSON.stringify(rest)}\n`;
  }
  return csvRow([e.at, dubaiDateOf(e.at), e.seq, e.action, whoOf(e), typeof e.details.orderId === 'string' ? e.details.orderId : typeof e.details.expenseId === 'string' ? e.details.expenseId : '', JSON.stringify(e.details), e.id, e.file, e.line, e.mac]);
}

export const AUDIT_CSV_HEADERS = ['at_utc', 'date_uae', 'seq', 'action', 'who', 'order', 'details', 'entry_id', 'file', 'line', 'mac'];

/** The export as pieces of text (CSV with its BOM and header first), a few hundred entries each: for streaming. */
export function* auditExportChunks(entries: Iterable<AuditEntry>, format: 'csv' | 'jsonl', per = 500): Generator<string> {
  let chunk = format === 'csv' ? csvHead(AUDIT_CSV_HEADERS) : '';
  let n = 0;
  for (const e of entries) {
    chunk += exportLine(e, format);
    if (++n % per === 0) {
      yield chunk;
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}

/** The filtered entries as Excel-safe CSV, or as the original JSON lines (signatures included). */
export function auditExport(entries: Iterable<AuditEntry>, format: 'csv' | 'jsonl'): string {
  return [...auditExportChunks(entries, format)].join('');
}

/**
 * The audit export as the hub asks for it: one export at a time (429 otherwise), who exported what
 * written to the log first, then streamed a few hundred entries per piece (never one big string;
 * the shop answers other requests in between). An export that fails half-way is written to the
 * log too (audit.export_failed).
 */
export function auditExportStream(by: string, format: 'csv' | 'jsonl', filters: AuditQuery): ReadableStream<Uint8Array> {
  const release = takeExportLock();
  let chunks: Generator<string>;
  try {
    const shown = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    auditOrThrow('audit.exported', { by, format, filters: shown });
    chunks = auditExportChunks(iterAuditEntries(filters), format);
  } catch (err) {
    release();
    throw err;
  }
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const next = chunks.next();
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(encoder.encode(next.value));
      } catch (err) {
        release();
        const error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
        audit('audit.export_failed', { by, format, error });
        logEvent('error', 'audit_export_failed', { error });
        controller.error(err);
      }
    },
    cancel() {
      release();
      chunks.return(undefined);
    },
  });
}
