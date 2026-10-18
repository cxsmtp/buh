import fs from 'node:fs';
import { dubaiDateOf } from '@/lib/reportPeriods';
import { auditFiles, verifyAllAuditLogs } from './audit';
import { toCsv } from './csv';
import { dataFile } from './dataDir';

/**
 * Reading the audit log back (Money → Audit log, and the accountant's export): newest first,
 * filtered by UAE date, action, who and order number, a page at a time, with the chain check of
 * every month. Read-only: nothing here writes to it. The entries are already redacted (secrets by
 * name, customers' phones and emails masked) when they are written (src/lib/server/audit.ts).
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

/** Every entry matching the query, oldest first (unreadable lines are skipped here; the chain check reports them). */
export function auditEntries(q: AuditQuery = {}): AuditEntry[] {
  const from = q.from && DATE.test(q.from) ? q.from : undefined;
  const to = q.to && DATE.test(q.to) ? q.to : undefined;
  const action = (q.action ?? '').trim().toLowerCase().slice(0, 80);
  const who = (q.who ?? '').trim().toLowerCase().slice(0, 120);
  const order = (q.order ?? '').trim().toUpperCase().slice(0, 60);
  const out: AuditEntry[] = [];
  for (const file of filesFor(from, to)) {
    let text = '';
    try {
      text = fs.readFileSync(dataFile(file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      let e: AuditEntry;
      try {
        e = { ...JSON.parse(lines[i]), file, line: i + 1 };
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
      out.push(e);
    }
  }
  return out;
}

export interface AuditPage {
  entries: Array<Omit<AuditEntry, 'prev' | 'mac'> & { who: string }>;
  total: number;
  page: number;
  pages: number;
  actions: string[];
  verification: ReturnType<typeof verifyAllAuditLogs>;
}

/** One page (50 by default), newest first, with the list of actions for the filter and the chain check. */
export function auditPage(q: AuditQuery & { page?: number; pageSize?: number } = {}): AuditPage {
  const all = auditEntries(q).reverse();
  const size = Math.min(Math.max(10, Math.floor(q.pageSize ?? 50)), 200);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const page = Math.min(Math.max(1, Math.floor(q.page ?? 1)), pages);
  const actions = [...new Set(auditEntries({}).map((e) => e.action))].sort();
  return {
    entries: all.slice((page - 1) * size, page * size).map(({ prev: _p, mac: _m, ...e }) => {
      void _p;
      void _m;
      return { ...e, who: whoOf(e) };
    }),
    total: all.length,
    page,
    pages,
    actions,
    verification: verifyAllAuditLogs(),
  };
}

/** The chain check in words, for the hub and the accountant's README. */
export function verificationText(v: ReturnType<typeof verifyAllAuditLogs>): string[] {
  if (!v.months.length) return ['The audit log is empty.'];
  if (v.ok) return [`The log is intact: ${v.entries} entries in ${v.months.length} month${v.months.length === 1 ? '' : 's'}, every entry's signature and link to the one before checked.`];
  const lines: string[] = [];
  for (const m of v.months) {
    if (m.ok) lines.push(`${m.file}: intact (${m.entries} entries).`);
    else if (m.otherKey) lines.push(`${m.file}: ${m.entries} entries, all links in order, but signed with another server's key (a backup restored onto a new server): it can't be checked here.`);
    else lines.push(`${m.file}: BROKEN at ${m.problems[0]}${m.problems.length > 1 ? ` (and ${m.problems.length - 1} more problem${m.problems.length === 2 ? '' : 's'})` : ''}.`);
  }
  return lines;
}

/** The filtered entries as Excel-safe CSV, or as the original JSON lines (signatures included). */
export function auditExport(entries: AuditEntry[], format: 'csv' | 'jsonl'): string {
  if (format === 'jsonl') {
    return entries.map(({ file: _f, line: _l, ...e }) => {
      void _f;
      void _l;
      return JSON.stringify(e);
    }).join('\n') + (entries.length ? '\n' : '');
  }
  return toCsv(
    ['at_utc', 'date_uae', 'seq', 'action', 'who', 'order', 'details', 'entry_id', 'file', 'line', 'mac'],
    entries.map((e) => [e.at, dubaiDateOf(e.at), e.seq, e.action, whoOf(e), typeof e.details.orderId === 'string' ? e.details.orderId : typeof e.details.expenseId === 'string' ? e.details.expenseId : '', JSON.stringify(e.details), e.id, e.file, e.line, e.mac])
  );
}
