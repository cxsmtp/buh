import { sweepChats } from './chat';
import { startChatMail } from './chatMail';
import { ensureAdminAccount } from './adminAuth';
import { ensureAdminLink } from './adminLinkSetup';
import { MIN_PASSPHRASE_LENGTH, auditRestoreOnce, emailConfigured, startBackupSchedule } from './backup';
import { refreshPayHashes } from './bankPay';
import { ensureChangeTriggers, getDb } from './db';
import { migrateDriveSecrets } from './driveBackup';
import { backupPassphrase } from './backupSecret';
import { backfillRefundLedger, normalizeBankStates, startUnconfirmedSweep } from './orders';
import { startMonitor } from './monitor';
import { startCardSweep } from './payments';
import { auditStaffRestoreOnce } from './staffAuth';
import { startFestivalRefresh } from './theme';
import { startSeoWatch } from './seoWatch';
import { logEvent } from './log';
import { liveGateways } from '@/lib/otpService';

/** Runs once when the server starts (src/instrumentation.ts). Never throws: the shop must still start. */
export async function onStartup() {
  try {
    await ensureAdminAccount();
  } catch (err) {
    logEvent('error', 'admin_account_init_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Each step on its own: one that fails (the database busy during an update, a full disk) is
  // logged and never stops the others (backups and monitoring above all).
  step('database_open', () => getDb()); // open (and migrate) the database now, not on the first customer's request
  // What changed since the last backup is counted by triggers: any a table rebuild lost are made again.
  step('change_triggers', () => {
    const made = ensureChangeTriggers(getDb());
    if (made.length) logEvent('warn', 'backup_triggers_repaired', { count: made.length, triggers: made.join(', ') });
  });
  // Restored from a backup since the last start: in the audit log, once.
  step('restore_audit', auditRestoreOnce);
  // Accountants a restore revoked (the backup may predate a revoke): in the audit log, once.
  step('restore_staff_audit', auditStaffRestoreOnce);
  // Google Drive secrets the first version kept in the database: moved to their own file.
  step('drive_secrets', migrateDriveSecrets);
  step('backup_schedule', startBackupSchedule);
  step('festival_refresh', startFestivalRefresh);
  // A festival's gift page going live: told to IndexNow once (only when the owner switched IndexNow on).
  step('seo_watch', startSeoWatch);
  step('monitor', startMonitor);
  step('chat', startChat);
  // Card orders not paid within 10 minutes: stopped at Stripe, cancelled, pieces back on sale.
  step('card_sweep', startCardSweep);
  // Settings → Phone check "WhatsApp (free)": orders not confirmed in time are cancelled, pieces back on sale.
  step('unconfirmed_sweep', startUnconfirmedSweep);
  // Restored onto a server with another key: the bank-transfer orders' private links follow it.
  // Bank orders an older version wrote after migration 10 (an update's overlap, a rollback) get
  // their state. Card refunds from before the refunds ledger are filled in. All retried every
  // minute until they work, and then kept up (all are cheap).
  startBankUpkeep();
  try {
    // The Admin Hub's private link: made (and printed once) on the first start, or by the update that brought it.
    ensureAdminLink();
  } catch (err) {
    logEvent('error', 'admin_link_init_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  if (process.env.NODE_ENV === 'production' && !emailConfigured()) {
    console.error('!! Backups are not emailed: set up email in Admin Hub → Settings → Email (or SMTP_HOST, SMTP_USER, SMTP_PASS and BACKUP_EMAIL in .env.production).');
  }
  // The backup password: chosen in the hub (DATA_DIR/backup-secret.json) or BACKUP_PASSPHRASE.
  let passphrase = '';
  try {
    passphrase = backupPassphrase();
  } catch (err) {
    console.error(`!! ${err instanceof Error ? err.message : String(err)}`);
    passphrase = 'unreadable (reported above)';
  }
  if (process.env.NODE_ENV === 'production' && passphrase.length < MIN_PASSPHRASE_LENGTH) {
    console.error(
      passphrase
        ? `!! BACKUP_PASSPHRASE is shorter than ${MIN_PASSPHRASE_LENGTH} characters: emailed backups are easier to crack.`
        : '!! No backup password is set: backups (customer names, phones, addresses) are emailed unencrypted. Set one in Admin Hub → Settings → System & backups.'
    );
  }

  const gateways = await liveGateways().catch(() => ({}) as Awaited<ReturnType<typeof liveGateways>>);
  const { phoneCheckMode, phoneVerificationConfig, getSettings } = await import('./settings');
  const whatsappMode = (() => {
    try {
      return phoneCheckMode() === 'whatsapp';
    } catch {
      return false;
    }
  })();
  if (whatsappMode) {
    // No codes are sent: the customer's WhatsApp message confirms the order, so the shop's number is needed.
    const number = (() => {
      try {
        return getSettings('store').whatsappNumber;
      } catch {
        return 'unknown';
      }
    })();
    if (process.env.NODE_ENV === 'production' && !number) {
      console.error('!! Phone check is "WhatsApp (free)" but no WhatsApp number is set (Admin Hub → Settings → Store & contact): orders cannot be confirmed on WhatsApp; call each customer.');
    }
    return;
  }
  const firebaseOn = (() => {
    try {
      return phoneVerificationConfig().method === 'firebase';
    } catch {
      return false;
    }
  })();
  const hasGateway = Boolean(gateways.twilio || gateways.infobip || gateways.webhook) || firebaseOn;
  if (process.env.NODE_ENV === 'production' && !hasGateway && process.env.OTP_DEV_MODE !== 'true') {
    console.error(
      [
        '',
        '!! No SMS gateway is configured (Admin Hub → SMS, or TWILIO_* / INFOBIP_* / SMS_WEBHOOK_URL).',
        '!! Checkout requires a verified UAE mobile, so customers cannot place orders',
        '!! until one is set in .env.production. See HOSTINGER_DEPLOYMENT_GUIDE.md.',
        '',
      ].join('\n')
    );
  }
}

function step(name: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    logEvent('error', 'startup_step_failed', { step: name, error: err instanceof Error ? err.message : String(err) });
  }
}

let bankUpkeep: ReturnType<typeof setInterval> | null = null;

/** One round of the upkeep (bank transfers, the refunds ledger); true when every part worked. Exported for tests. */
export function bankUpkeepOnce(): boolean {
  let ok = true;
  try {
    const rehashed = refreshPayHashes();
    if (rehashed) logEvent('info', 'pay_links_rehashed', { orders: rehashed });
  } catch (err) {
    ok = false;
    logEvent('warn', 'pay_links_rehash_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const fixed = normalizeBankStates();
    if (fixed) logEvent('info', 'bank_states_filled_in', { orders: fixed });
  } catch (err) {
    ok = false;
    logEvent('warn', 'bank_states_fill_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    // Card refunds made before the refunds ledger (or by an older version during an update): filled in.
    backfillRefundLedger();
  } catch (err) {
    ok = false;
    logEvent('warn', 'refund_ledger_fill_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return ok;
}

function startBankUpkeep() {
  bankUpkeepOnce();
  if (bankUpkeep) return;
  bankUpkeep = setInterval(() => void bankUpkeepOnce(), 60_000);
  bankUpkeep.unref();
}

/** Chat: email the owner and read emailed replies; every 30 s, reassure customers left waiting. */
function startChat() {
  startChatMail();
  if (process.env.CHAT_SWEEP_DISABLED === '1') return;
  const t = setInterval(() => {
    try {
      sweepChats();
    } catch (err) {
      logEvent('warn', 'chat_sweep_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 30_000);
  t.unref();
}
