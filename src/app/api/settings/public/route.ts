import { handleRouteError, json } from '@/lib/server/http';
import { bankTransferMode, cardFeePercent, cardPaymentsReady, contactEmail, getSettings, phoneCodesOn, phoneVerificationConfig } from '@/lib/server/settings';
import { storefrontTheme } from '@/lib/server/theme';

/**
 * What every visitor sees: branding, whether checkout offers bank transfer (never
 * the account itself: that is only sent privately, see src/lib/server/bankPay.ts),
 * the store's contact details (WhatsApp, Instagram…), the catalogue's categories and the
 * low-stock threshold, the support email, today's festival look, and how
 * checkout verifies phones (the Firebase web config only when Firebase is the
 * switched-on SMS option), and whether checkout takes cards (with the Stripe
 * publishable key, which is public by design, and the card fee's percent). Nothing here is secret.
 */
export function GET() {
  try {
    const store = getSettings('store');
    const catalog = getSettings('catalog');
    return json({
      brand: getSettings('brand'),
      // Offered at all, and how: our details sent automatically, or asked for on the shop's WhatsApp.
      bankTransfer: bankTransferMode() !== null,
      bankTransferMode: bankTransferMode(),
      // Pages from before this version read bank.iban: an empty object keeps them working
      // (they simply don't offer bank transfer) until they reload.
      bank: {},
      store,
      catalog: { categories: catalog.categories, lowStockThreshold: catalog.lowStockThreshold },
      supportEmail: contactEmail(),
      festival: festivalView(),
      phoneVerification: phoneVerificationConfig(),
      chat: chatView(),
      delivery: getSettings('delivery'),
      payments: paymentsView(),
    });
  } catch (err) {
    return handleRouteError(err, 'settings/public');
  }
}

/**
 * Card payments: only switched on with every key; the publishable key only (never the secret ones).
 * phoneCheck: an SMS gateway is on, so card orders prove the phone with a code too.
 */
function paymentsView() {
  const p = getSettings('payments');
  return cardPaymentsReady(p) ? { card: true, publishableKey: p.stripePublishableKey, cardFeePercent: cardFeePercent(p), ...(phoneCodesOn() ? { phoneCheck: true } : {}) } : { card: false };
}

function chatView() {
  const a = getSettings('assistant');
  return a.enabled ? { name: a.name, greeting: a.greeting } : null;
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
