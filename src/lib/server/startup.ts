import { ensureAdminAccount } from './adminAuth';
import { emailConfigured, startBackupSchedule } from './backup';
import { getDb } from './db';
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
  } catch (err) {
    logEvent('error', 'startup_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  if (process.env.NODE_ENV === 'production' && !emailConfigured()) {
    console.error('!! Backups are not emailed: set SMTP_HOST, SMTP_USER, SMTP_PASS and BACKUP_EMAIL (see HOSTINGER_DEPLOYMENT_GUIDE.md).');
  }

  const gateways = await liveGateways().catch(() => ({}) as Awaited<ReturnType<typeof liveGateways>>);
  const hasGateway = Boolean(gateways.twilio || gateways.infobip || gateways.webhook);
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
