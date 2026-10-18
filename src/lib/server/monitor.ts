import fs from 'node:fs';
import { audit } from './audit';
import { backupHealth } from './backup';
import { emailConfigured, ownerEmail, sender, transport } from './mail';
import { dataDir } from './dataDir';
import { getDb } from './db';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { awaitingWhatsAppCount } from './orders';
import { listProducts } from './products';
import { getSettings } from './settings';

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
  if (backup.level === 'failing') problems.push({ id: 'backup', level: 'failing', text: backup.lastError ? `Backups are failing: ${backup.lastError}` : 'No backup in the last day.' });
  else if (backup.level === 'warning') problems.push({ id: 'backup', level: 'warning', text: backup.lastEmailError || backup.notice || 'Backups need attention.' });
  const sms = getSettings('sms');
  const envGateway = Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.INFOBIP_API_KEY || process.env.SMS_WEBHOOK_URL);
  if (process.env.NODE_ENV === 'production' && !sms.isEnabled && !envGateway && process.env.OTP_DEV_MODE !== 'true') {
    problems.push({ id: 'sms', level: 'failing', text: 'No SMS gateway is switched on: customers cannot verify their phone, so they cannot order.' });
  }
  return problems;
}

async function sendOwner(subject: string, text: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    await (await transport()).sendMail({ from: sender(), to: ownerEmail(), subject: `[Beautiful UAE Home] ${subject}`, text });
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

/** Yesterday in the UAE: orders, sales, what is low or sold out, and open problems. */
export function dailySummary(now = new Date()): { subject: string; text: string } {
  const day = new Date(now.getTime() + 4 * 3600_000 - 24 * 3600_000).toISOString().slice(0, 10); // yesterday, Asia/Dubai
  const from = new Date(`${day}T00:00:00+04:00`).toISOString();
  const to = new Date(`${day}T24:00:00+04:00`).toISOString();
  const rows = getDb().prepare("SELECT status, total_fils FROM orders WHERE created_at >= ? AND created_at < ?").all(from, to) as Array<{ status: string; total_fils: number }>;
  const kept = rows.filter((r) => r.status !== 'cancelled');
  const sales = kept.reduce((n, r) => n + r.total_fils, 0) / 100;
  const pending = (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending_confirmation'").get() as { n: number }).n;
  const awaitingWhatsApp = awaitingWhatsAppCount();
  const threshold = getSettings('catalog').lowStockThreshold;
  const products = listProducts();
  const soldOut = products.filter((p) => p.stockCount === 0).map((p) => p.title);
  const low = products.flatMap((p) => p.profiles.filter((s) => (p.stockBySize[s.id] ?? 0) > 0 && (p.stockBySize[s.id] ?? 0) <= threshold).map((s) => `${p.title} (${s.name}: ${p.stockBySize[s.id]})`));
  const problems = currentProblems(now.getTime());
  const lines = [
    `Yesterday (${day}): ${kept.length} order${kept.length === 1 ? '' : 's'}, AED ${sales.toFixed(2)}${rows.length - kept.length ? ` (${rows.length - kept.length} cancelled)` : ''}.`,
    `Waiting for your confirmation: ${pending}.`,
    ...(awaitingWhatsApp ? [`Waiting for the customer's WhatsApp message: ${awaitingWhatsApp}.`] : []),
    '',
    soldOut.length ? `Sold out (${soldOut.length}): ${soldOut.slice(0, 20).join('; ')}` : 'Nothing is sold out.',
    low.length ? `Low (${low.length}): ${low.slice(0, 30).join('; ')}` : 'Nothing is running low.',
    '',
    problems.length ? `Needs attention:\n${problems.map((p) => `- ${p.text}`).join('\n')}` : 'Everything is running normally.',
  ];
  return { subject: `Daily summary ${day}: ${kept.length} orders, AED ${sales.toFixed(0)}`, text: lines.join('\n') };
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
        const { subject, text } = dailySummary(now);
        await sendOwner(subject, text);
      }
    } catch (err) {
      logEvent('warn', 'monitor_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  setTimeout(() => void tick(), 120_000).unref();
  timer = setInterval(() => void tick(), 15 * 60_000);
  timer.unref();
}
