import fs from 'node:fs';
import type { Order } from '@/types';
import { PALETTE } from '@/lib/design/tokens';
import { audit } from './audit';
import { BACKUP_LIMITS, backupDataSize, backupHealth } from './backup';
import { emailConfigured, ownerEmail, sender, transport } from './mail';
import { dataDir } from './dataDir';
import { driveProblem } from './driveBackup';
import { getDb } from './db';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { awaitingWhatsAppCount, cardTakings, ordersNeedingAttention, receiptsNoRoom, summaryOrderRows, transfersAwaitedCount, transfersToCheckCount, unconfirmedPressure } from './orders';
import { listProducts } from './products';
import { vatStatus } from './reports';
import { getSettings, phoneCheckMode } from './settings';

/**
 * Keeps an eye on the shop so the owner doesn't have to:
 *  - every 15 minutes: free disk space, backups, and (daily) a database check;
 *    a problem is emailed once when it starts, again daily while it lasts, and
 *    an "all clear" when it is fixed;
 *  - every morning (8:00 UAE time): a short summary email of yesterday's
 *    orders and sales, what is low or sold out, and anything needing attention.
 * Emails go to BACKUP_EMAIL through the backup SMTP settings. Nothing here
 * ever stops the shop: failures are logged.
 */

export interface Problem {
  id: string;
  level: 'warning' | 'failing';
  text: string;
}

const MIN_FREE_BYTES = 1024 ** 3; // 1 GB
const MIN_FREE_RATIO = 0.1;

export function diskSpace(): { free: number; total: number } | null {
  try {
    const s = fs.statfsSync(dataDir());
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** The database's own check (fast form); the result is kept for a day. */
function databaseOk(now: number): boolean {
  const last = kvGet<{ ok: boolean; at: number }>('monitor:dbcheck')?.data;
  if (last && now - last.at < 24 * 3600_000) return last.ok;
  let ok = false;
  try {
    ok = getDb().pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    ok = false;
  }
  kvSet('monitor:dbcheck', { ok, at: now });
  return ok;
}

/** Everything that needs the owner's attention right now. */
export function currentProblems(now = Date.now()): Problem[] {
  const problems: Problem[] = [];
  const disk = diskSpace();
  if (disk && (disk.free < MIN_FREE_BYTES || disk.free / disk.total < MIN_FREE_RATIO)) {
    problems.push({ id: 'disk', level: disk.free < MIN_FREE_BYTES / 4 ? 'failing' : 'warning', text: `Disk space is low: ${(disk.free / 1024 ** 3).toFixed(1)} GB free of ${(disk.total / 1024 ** 3).toFixed(0)} GB.` });
  }
  if (!databaseOk(now)) problems.push({ id: 'database', level: 'failing', text: 'The database check failed. Restore the latest backup (see the deployment guide).' });
  const backup = backupHealth(now);
  if (backup.level === 'failing') problems.push({ id: 'backup', level: 'failing', text: backup.lastError ? `Backups are failing: ${backup.lastError}` : backup.overdueText || backup.notice || 'Backups need attention.' });
  else if (backup.level === 'warning') problems.push({ id: 'backup', level: 'warning', text: backup.lastEmailError || backup.notice || backup.offServerWarning || 'Backups need attention.' });
  // Google says the server's clock is wrong: old backups are kept until it is fixed (its own line).
  if (backup.clockWarning) problems.push({ id: 'clock', level: 'warning', text: backup.clockWarning });
  // The off-server copy in Google Drive (when switched on): failing or paused, never the local backup's problem.
  // Compared with the last backup handed to Drive (a "Back up now" with nothing new is not copied again).
  const drive = driveProblem(backup.lastDriveHandoffAt ?? backup.lastSuccessAt, backup.intervalHours, now);
  if (drive) problems.push(drive);
  // The data to back up nears (80%) or passes the most one backup holds: said before backups stop.
  try {
    const size = backupDataSize();
    const amount = `${(size.bytes / 1024 ** 3).toFixed(1)} GB`;
    const limit = `${(size.limit / 1024 ** 3).toFixed(0)} GB`;
    if (size.ratio > 1) problems.push({ id: 'backup_size', level: 'failing', text: `The shop's data (${amount}) is more than one backup can hold (${limit}): new backups are refused until some is removed (old product photos, bills no longer needed).` });
    else if (size.ratio >= BACKUP_LIMITS.warnRatio) problems.push({ id: 'backup_size', level: 'warning', text: `The shop's data to back up is ${amount}, ${Math.floor(size.ratio * 100)}% of the most one backup can hold (${limit}). Remove old product photos or bills you no longer need before it is full.` });
  } catch (err) {
    logEvent('warn', 'backup_size_check_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  if (phoneCheckMode() === 'whatsapp') {
    // Settings → Phone check "WhatsApp (free)": no gateway needed, but the shop's WhatsApp number is.
    if (!getSettings('store').whatsappNumber) {
      problems.push({ id: 'whatsapp', level: 'warning', text: 'No WhatsApp number is set (Settings → Store & contact): customers can’t confirm their orders on WhatsApp, so call each one before shipping.' });
    }
  }
  // Orders no code proved, waiting for WhatsApp: near the shop cap (80%), or the cap refused a customer in the last day.
  const pressure = unconfirmedPressure(now);
  if (pressure.near || pressure.refusedAt) {
    problems.push({
      id: 'unconfirmed',
      level: 'warning',
      text: `${pressure.open} orders are waiting for their WhatsApp confirmation (new ones are refused at ${pressure.cap})${pressure.refusedAt ? '; the cap refused a customer in the last day' : ''}. In Orders, confirm the real ones and cancel any you don't recognise.`,
    });
  }
  if (phoneCheckMode() !== 'whatsapp') {
    const sms = getSettings('sms');
    const envGateway = Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.INFOBIP_API_KEY || process.env.SMS_WEBHOOK_URL);
    if (process.env.NODE_ENV === 'production' && !sms.isEnabled && !envGateway && process.env.OTP_DEV_MODE !== 'true') {
      problems.push({ id: 'sms', level: 'failing', text: 'No SMS gateway is switched on: customers cannot verify their phone, so they cannot order (or choose Settings → Phone check “WhatsApp (free)”).' });
    }
  }
  // A transfer screenshot refused in the last day: the disk, or the receipts folder, is too full.
  const noRoom = receiptsNoRoom();
  if (noRoom) problems.push({ id: 'receipts', level: 'warning', text: `Transfer screenshots can’t be uploaded: ${noRoom.why}. Customers are asked to send them on WhatsApp. Free some space on the server.` });
  // A refund that failed, a booking after a cancel, a card order to refund in Stripe's dashboard.
  const attention = ordersNeedingAttention();
  if (attention) problems.push({ id: 'orders', level: 'warning', text: `${attention} order${attention === 1 ? ' needs' : 's need'} your attention (Orders: the red notes). Mark each as handled once done.` });
  // Not VAT-registered: 12 months of sales near (80%) or over the AED 375,000 mandatory threshold.
  try {
    const vat = vatStatus(now);
    if (vat.level !== 'ok') problems.push({ id: 'vat', level: 'warning', text: vat.text });
  } catch (err) {
    logEvent('warn', 'vat_check_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return problems;
}

async function sendOwner(subject: string, text: string, html?: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    await (await transport()).sendMail({ from: sender(), to: ownerEmail(), subject: `[Beautiful UAE Home] ${subject}`, text, ...(html ? { html } : {}) });
    return true;
  } catch (err) {
    logEvent('warn', 'owner_email_failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Email problems when they start, daily while they last, and when they clear. */
export async function checkAndAlert(now = Date.now()): Promise<Problem[]> {
  const problems = currentProblems(now);
  const state = kvGet<Record<string, number>>('monitor:alerted')?.data ?? {};
  const next: Record<string, number> = {};
  for (const p of problems) {
    const last = state[p.id];
    if (!last || now - last > 24 * 3600_000) {
      audit('monitor.problem', { id: p.id, level: p.level, text: p.text });
      await sendOwner(p.level === 'failing' ? `Needs attention: ${p.id}` : `Warning: ${p.id}`, `${p.text}\n\nOpen the Admin Hub → Settings → System & backups for details.`);
      next[p.id] = now;
    } else {
      next[p.id] = last;
    }
  }
  for (const id of Object.keys(state)) {
    if (!next[id]) {
      audit('monitor.cleared', { id });
      await sendOwner(`Resolved: ${id}`, `The ${id} problem reported earlier is resolved.`);
    }
  }
  kvSet('monitor:alerted', next);
  return problems;
}

export interface SummarySection {
  title: string;
  /** One line each; `tone` colours it in the HTML email. */
  items: Array<{ text: string; tone?: 'action' | 'warn' | 'ok' }>;
}

const aed = (fils: number) => `AED ${(fils / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PAYMENT_NAMES: Record<string, string> = { cod: 'cash on delivery', bank_transfer: 'bank transfer', online_card: 'card' };

/** "3 h ago", "2 days ago". */
function ago(iso: string, now: Date): string {
  const h = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 3600_000));
  return h < 1 ? 'just now' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** A first name and an initial: enough to recognise the order, without the full name in an email. */
function shortName(full: string): string {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'a customer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/** One line per order: number, customer, amount, payment, when (and what is wrong, for flagged ones). */
function orderLines(kind: 'confirm' | 'transfer' | 'attention', label: string, total: number, now: Date): SummarySection['items'] {
  if (!total) return [];
  const rows = summaryOrderRows(kind, 10);
  const lines = rows.map((r) => {
    let name = 'a customer';
    try {
      name = shortName((JSON.parse(r.data) as Order).customer?.fullName);
    } catch {
      // the totals still count it
    }
    let why = '';
    if (kind === 'attention' && r.needs_attention) {
      try {
        why = ` — ${String((JSON.parse(r.needs_attention) as { text?: string }).text ?? '').slice(0, 140)}`;
      } catch {
        why = '';
      }
    }
    return { text: `${label}: ${r.id} · ${name} · ${aed(r.total_fils)} · ${PAYMENT_NAMES[r.payment_method] ?? r.payment_method} · ${ago(r.created_at, now)}${why}`, tone: 'action' as const };
  });
  return total > rows.length ? [...lines, { text: `…and ${total - rows.length} more (${label.toLowerCase()}).`, tone: 'action' as const }] : lines;
}

function ordersBetween(from: string, to: string) {
  return getDb().prepare('SELECT status, total_fils, data FROM orders WHERE created_at >= ? AND created_at < ?').all(from, to) as Array<{ status: string; total_fils: number; data: string }>;
}

/** The UAE day `daysAgo` before today, as [from, to) ISO times and its date. */
function dubaiDay(now: Date, daysAgo: number) {
  const day = new Date(now.getTime() + 4 * 3600_000 - daysAgo * 24 * 3600_000).toISOString().slice(0, 10);
  return { day, from: new Date(`${day}T00:00:00+04:00`).toISOString(), to: new Date(`${day}T24:00:00+04:00`).toISOString() };
}

/**
 * Yesterday in the UAE, in sections the owner can scan: what needs them first, then sales,
 * inventory and the system. Each line is short; the HTML email shows the same sections as
 * small tables (plain text for mail apps that don't show HTML).
 */
export function dailySummary(now = new Date()): { subject: string; text: string; html: string; sections: SummarySection[] } {
  const { day, from, to } = dubaiDay(now, 1);
  const rows = ordersBetween(from, to);
  const kept = rows.filter((r) => r.status !== 'cancelled');
  const salesFils = kept.reduce((n, r) => n + r.total_fils, 0);
  // The 7 days to yesterday, and the 7 before, for a simple trend.
  const week = ordersBetween(dubaiDay(now, 7).from, to).filter((r) => r.status !== 'cancelled');
  const prevWeek = ordersBetween(dubaiDay(now, 14).from, dubaiDay(now, 7).from).filter((r) => r.status !== 'cancelled');
  const weekFils = week.reduce((n, r) => n + r.total_fils, 0);
  const prevFils = prevWeek.reduce((n, r) => n + r.total_fils, 0);
  // What sold yesterday, most pieces first.
  const sold = new Map<string, number>();
  for (const r of kept) {
    try {
      for (const it of (JSON.parse(r.data) as Order).items ?? []) sold.set(it.title, (sold.get(it.title) ?? 0) + (Number(it.quantity) || 0));
    } catch {
      // an unreadable order is still counted in the totals
    }
  }
  const top = [...sold.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const pending = (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending_confirmation'").get() as { n: number }).n;
  const awaitingWhatsApp = awaitingWhatsAppCount();
  const transfersToCheck = transfersToCheckCount();
  const transfersAwaited = transfersAwaitedCount();
  let chats = 0;
  let chatRows: Array<{ customer_name: string; updated_at: string }> = [];
  try {
    chats = (getDb().prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE status = 'waiting'").get() as { n: number }).n;
    chatRows = getDb().prepare("SELECT customer_name, updated_at FROM chat_threads WHERE status = 'waiting' ORDER BY updated_at ASC LIMIT 10").all() as typeof chatRows;
  } catch {
    chats = 0;
  }
  const flagged = ordersNeedingAttention();
  const card = cardTakings(from, to);
  const threshold = getSettings('catalog').lowStockThreshold;
  const products = listProducts();
  const soldOut = products.filter((p) => p.stockCount === 0).map((p) => p.title);
  // The name before " • " (the shop's titles often add a long subtitle), and a size's short name.
  const short = (t: string) => t.split(' • ')[0].trim();
  const sizeShort = (n: string) => n.replace(/\s*\(.*\)\s*/g, '').replace(/ Size Bed| Bed$/g, '').trim();
  const lowByProduct = products
    .map((p) => ({ title: short(p.title), sizes: p.profiles.filter((s) => (p.stockBySize[s.id] ?? 0) > 0 && (p.stockBySize[s.id] ?? 0) <= threshold).map((s) => `${sizeShort(s.name)} ${p.stockBySize[s.id]}`) }))
    .filter((x) => x.sizes.length);
  const low = lowByProduct.flatMap((x) => x.sizes);
  const problems = currentProblems(now.getTime());
  let vat: ReturnType<typeof vatStatus> | null = null;
  try {
    vat = vatStatus(now.getTime());
  } catch {
    vat = null;
  }

  const action: SummarySection['items'] = [
    // Every order, transfer and chat that needs you, one line each, so the email is enough on its own.
    ...(pending ? [{ text: `Waiting for your confirmation: ${pending}.`, tone: 'action' as const }, ...orderLines('confirm', 'Confirm', pending, now)] : []),
    ...(transfersToCheck
      ? [{ text: `Bank transfers to check (screenshot received): ${transfersToCheck}. Compare each with your bank statement before you confirm.`, tone: 'action' as const }, ...orderLines('transfer', 'Check transfer', transfersToCheck, now)]
      : []),
    ...(flagged ? orderLines('attention', 'Look at', flagged, now) : []),
    ...(chats
      ? [
          { text: `Chats waiting for a reply: ${chats}.`, tone: 'action' as const },
          ...chatRows.map((c) => ({ text: `Reply to: ${shortName(c.customer_name) === 'a customer' ? 'a visitor' : shortName(c.customer_name)} · waiting since ${ago(c.updated_at, now)}`, tone: 'action' as const })),
        ]
      : []),
    ...(soldOut.length ? [{ text: `Restock: ${plural(soldOut.length, 'product')} sold out, ${plural(low.length, 'size')} running low (see Inventory below).`, tone: 'action' as const }] : []),
    ...problems.map((p) => ({ text: p.text, tone: p.level === 'failing' ? ('action' as const) : ('warn' as const) })),
    ...(vat && !vat.registered && vat.level !== 'ok' ? [{ text: vat.text, tone: 'action' as const }] : []),
  ];
  const trend = prevFils ? ` (${weekFils >= prevFils ? '+' : '−'}${Math.round((Math.abs(weekFils - prevFils) / prevFils) * 100)}% on the 7 days before)` : '';
  const sections: SummarySection[] = [
    { title: 'Action needed', items: action.length ? action : [{ text: 'Nothing needs you today.', tone: 'ok' }] },
    {
      title: `Sales — ${day}`,
      items: [
        { text: `Orders: ${kept.length}${rows.length - kept.length ? ` (${rows.length - kept.length} cancelled)` : ''}` },
        { text: `Sales: ${aed(salesFils)}${kept.length ? ` · average order ${aed(Math.round(salesFils / kept.length))}` : ''}` },
        ...(card.paid || card.refunded
          ? [{ text: `Paid by card (Stripe): ${card.paid}, AED ${(card.paidFils / 100).toFixed(2)}${card.refunded ? `; refunded to cards: ${card.refunded}, AED ${(card.refundedFils / 100).toFixed(2)}` : ''}.` }]
          : []),
        ...(transfersAwaited ? [{ text: `Bank transfers not received yet: ${transfersAwaited}.` }] : []),
        ...(awaitingWhatsApp ? [{ text: `Waiting for the customer's WhatsApp message: ${awaitingWhatsApp}.` }] : []),
        ...(top.length ? [{ text: `Best sellers: ${top.map(([t, n]) => `${t} × ${n}`).join('; ')}` }] : []),
        { text: `Last 7 days: ${plural(week.length, 'order')}, ${aed(weekFils)}${trend}` },
        ...(vat && (vat.registered || vat.level === 'ok') ? [{ text: vat.text }] : []),
      ],
    },
    {
      title: 'Inventory',
      items: [
        // One line per product: easy to scan on a phone.
        ...(soldOut.length
          ? [
              ...soldOut.slice(0, 10).map((t) => ({ text: `Sold out: ${short(t)}`, tone: 'warn' as const })),
              ...(soldOut.length > 10 ? [{ text: `…and ${soldOut.length - 10} more sold out (Inventory → Sold out).`, tone: 'warn' as const }] : []),
            ]
          : [{ text: 'Nothing is sold out.', tone: 'ok' as const }]),
        ...(lowByProduct.length
          ? [
              ...lowByProduct.slice(0, 10).map((x) => ({ text: `Low: ${x.title} — ${x.sizes.join(', ')} left`, tone: 'warn' as const })),
              ...(lowByProduct.length > 10 ? [{ text: `…and ${lowByProduct.length - 10} more running low (Inventory → Low).`, tone: 'warn' as const }] : []),
            ]
          : [{ text: 'Nothing is running low.', tone: 'ok' as const }]),
        { text: `On sale: ${plural(products.length, 'product')}.` },
      ],
    },
    {
      title: 'System',
      items: problems.length
        ? [{ text: `Needs attention: ${plural(problems.length, 'item')} (listed under Action needed).`, tone: 'warn' }]
        : [{ text: 'Everything is running normally (backups, disk, database).', tone: 'ok' }],
    },
  ];

  const text = [
    `Beautiful UAE Home: your summary for ${day}`,
    '',
    ...sections.flatMap((sec) => [sec.title.toUpperCase(), ...sec.items.map((i) => `  • ${i.text}`), '']),
    'Every item above is in the Admin Hub too; nothing else needs your attention.',
  ].join('\n');
  const actions = action.length;
  return {
    subject: `Daily summary ${day}: ${kept.length} orders, AED ${(salesFils / 100).toFixed(0)}${actions ? ` · ${plural(actions, 'thing')} to do` : ''}`,
    text,
    html: summaryHtml(day, sections),
    sections,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The summary as a simple email: one small table per section, inline styles only (mail apps drop the rest). */
function summaryHtml(day: string, sections: SummarySection[]): string {
  const P = PALETTE;
  const colour = { action: P.danger, warn: P.warning, ok: P.success } as const;
  const mark = { action: '●', warn: '▲', ok: '✓' } as const;
  const blocks = sections
    .map(
      (sec) => `<h2 style="font:600 15px/1.3 Arial,sans-serif;color:${P.ink};margin:22px 0 8px;border-bottom:1px solid ${P["gold-light"]};padding-bottom:4px">${esc(sec.title)}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${sec.items
        .map(
          (i) => `<tr><td style="width:18px;vertical-align:top;padding:3px 0;font:13px/1.5 Arial,sans-serif;color:${i.tone ? colour[i.tone] : '${P["gold-deep"]}'}">${i.tone ? mark[i.tone] : '•'}</td><td style="padding:3px 0;font:14px/1.5 Arial,sans-serif;color:${P.ink}">${esc(i.text)}</td></tr>`
        )
        .join('')}</table>`
    )
    .join('\n');
  return `<!doctype html><html><body style="margin:0;background:${P.ivory}"><div style="max-width:560px;margin:0 auto;padding:20px 16px;background:${P.paper}">
<p style="font:600 18px/1.3 Georgia,serif;color:${P.ink};margin:0">Beautiful UAE Home</p>
<p style="font:13px/1.4 Arial,sans-serif;color:${P["ink-muted"]};margin:4px 0 0">Your summary for ${esc(day)}</p>
${blocks}
<p style="font:12px/1.5 Arial,sans-serif;color:${P["ink-muted"]};margin:24px 0 0">Every item above is in the Admin Hub too; nothing else needs your attention.</p>
</div></body></html>`;
}

let timer: NodeJS.Timeout | null = null;

/** Start the checks (every 15 minutes) and the 8:00 summary. Off with MONITOR_DISABLED=true. */
export function startMonitor() {
  if (timer || process.env.MONITOR_DISABLED === 'true') return;
  const tick = async () => {
    try {
      await checkAndAlert();
      const now = new Date();
      const dubaiHour = (now.getUTCHours() + 4) % 24;
      const today = new Date(now.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
      const lastSent = kvGet<string>('monitor:summary')?.data;
      if (dubaiHour >= 8 && lastSent !== today && process.env.DAILY_SUMMARY !== 'false') {
        kvSet('monitor:summary', today); // one copy only, even with two copies of the shop running
        const { subject, text, html } = dailySummary(now);
        await sendOwner(subject, text, html);
      }
    } catch (err) {
      logEvent('warn', 'monitor_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  setTimeout(() => void tick(), 120_000).unref();
  timer = setInterval(() => void tick(), 15 * 60_000);
  timer.unref();
}
