import { handleRouteError, json } from '@/lib/server/http';
import { contactEmail, getSettings } from '@/lib/server/settings';

/**
 * What every visitor sees: branding, bank details for transfers, the store's
 * contact details (WhatsApp, Instagram…), the catalogue's categories and the
 * low-stock threshold, and the support email. Nothing here is secret.
 */
export function GET() {
  try {
    const store = getSettings('store');
    const catalog = getSettings('catalog');
    return json({
      brand: getSettings('brand'),
      bank: getSettings('bank'),
      store,
      catalog: { categories: catalog.categories, lowStockThreshold: catalog.lowStockThreshold },
      supportEmail: contactEmail(),
    });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}
