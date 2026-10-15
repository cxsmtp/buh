import { handleRouteError, json } from '@/lib/server/http';
import { contactEmail, getSettings } from '@/lib/server/settings';
import { storefrontTheme } from '@/lib/server/theme';

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
      festival: festivalView(),
    });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}

/** Today's festival look (or the everyday one), with what the admin wants shown. */
function festivalView() {
  const t = getSettings('theme');
  try {
    const { pick, theme } = storefrontTheme();
    return { themeId: pick.themeId, festivalId: pick.festivalId ?? null, phase: pick.phase, daysToStart: pick.daysToStart ?? null, theme, showBanner: t.showBanner, showMarquee: t.showMarquee };
  } catch {
    return null; // never let a calendar problem break the shop
  }
}
