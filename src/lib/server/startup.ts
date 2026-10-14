import { ensureAdminAccount } from './adminAuth';
import { logEvent } from './log';
import { envGateways } from '@/lib/otpService';

/** Runs once when the server starts (src/instrumentation.ts). Never throws: the shop must still start. */
export async function onStartup() {
  try {
    await ensureAdminAccount();
  } catch (err) {
    logEvent('error', 'admin_account_init_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const gateways = envGateways();
  const hasGateway = Boolean(gateways.twilio || gateways.infobip || gateways.webhook);
  if (process.env.NODE_ENV === 'production' && !hasGateway && process.env.OTP_DEV_MODE !== 'true') {
    console.error(
      [
        '',
        '!! No SMS gateway is configured (TWILIO_*, INFOBIP_* or SMS_WEBHOOK_URL).',
        '!! Checkout requires a verified UAE mobile, so customers cannot place orders',
        '!! until one is set in .env.production. See HOSTINGER_DEPLOYMENT_GUIDE.md.',
        '',
      ].join('\n')
    );
  }
}
