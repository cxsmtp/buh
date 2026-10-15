import { handleRouteError, json } from '@/lib/server/http';
import { supportEmail } from '@/lib/server/runtimeConfig';
import { getSettings } from '@/lib/server/settings';

/** What every visitor sees: branding, the bank details for transfers, and the support email. */
export function GET() {
  try {
    return json({ brand: getSettings('brand'), bank: getSettings('bank'), supportEmail: supportEmail() });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}
