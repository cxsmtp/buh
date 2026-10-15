import { sweepChats } from './chat';
import { startChatMail } from './chatMail';
import { ensureAdminAccount } from './adminAuth';
import { MIN_PASSPHRASE_LENGTH, emailConfigured, startBackupSchedule } from './backup';
import { getDb } from './db';
import { startMonitor } from './monitor';
import { startFestivalRefresh } from './theme';
import { logEvent } from './log';
import { liveGateways } from '@/lib/otpService';

/** Runs once when the server starts (src/instrumentation.ts). Never throws: the shop must still start. */
export async function onStartup() {
  try {
    await ensureAdminAccount();
  } catch (err) {
    logEvent('error', 'admin_account_init_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    getDb(); // open (and migrate) the database now, not on the first customer's request
    startBackupSchedule();
    startFestivalRefresh();
    startMonitor();
    startChat();
  } catch (err) {
    logEvent('error', 'startup_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  if (process.env.NODE_ENV === 'production' && !emailConfigured()) {
    console.error('!! Backups are not emailed: set up email in Admin Hub → Settings → Email (or SMTP_HOST, SMTP_USER, SMTP_PASS and BACKUP_EMAIL in .env.production).');
  }
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  if (process.env.NODE_ENV === 'production' && passphrase.length < MIN_PASSPHRASE_LENGTH) {
    console.error(
      passphrase
        ? `!! BACKUP_PASSPHRASE is shorter than ${MIN_PASSPHRASE_LENGTH} characters: emailed backups are easier to crack.`
        : '!! BACKUP_PASSPHRASE is not set: backups (customer names, phones, addresses) are emailed unencrypted.'
    );
  }

  const gateways = await liveGateways().catch(() => ({}) as Awaited<ReturnType<typeof liveGateways>>);
  const { phoneVerificationConfig } = await import('./settings');
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
