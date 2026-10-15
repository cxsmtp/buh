import { handleRouteError, json } from '@/lib/server/http';
import { supportEmail } from '@/lib/server/runtimeConfig';
import { getSettings, phoneVerificationConfig } from '@/lib/server/settings';

/**
 * What every visitor sees: branding, the bank details for transfers, the
 * support email, and how checkout verifies phones (with the Firebase web
 * config only when Firebase is the switched-on SMS option).
 */
export function GET() {
  try {
    return json({ brand: getSettings('brand'), bank: getSettings('bank'), supportEmail: supportEmail(), phoneVerification: phoneVerificationConfig() });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}
