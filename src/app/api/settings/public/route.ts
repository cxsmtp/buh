import { handleRouteError, json } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';

/** What every visitor sees: branding and the bank details for transfers. */
export function GET() {
  try {
    return json({ brand: getSettings('brand'), bank: getSettings('bank') });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}
