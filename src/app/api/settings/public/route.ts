import { handleRouteError, json } from '@/lib/server/http';
import { bankTransferMode, cardFeePercent, cardPaymentsReady, contactEmail, getSettings, phoneCheckMode, phoneCodesOn, phoneVerificationConfig } from '@/lib/server/settings';
import { MAX_UNVERIFIED_CARD_LINES, MAX_UNVERIFIED_CARD_QTY } from '@/lib/server/orders';
import { storefrontTheme } from '@/lib/server/theme';
import { vatAddedPercent } from '@/lib/server/vat';

/**
 * What every visitor sees: branding, whether checkout offers bank transfer (never
 * the account itself: that is only sent privately, see src/lib/server/bankPay.ts),
 * the store's contact details (WhatsApp, Instagram…), the catalogue's categories and the
 * low-stock threshold, the support email, today's festival look, and how
 * checkout verifies phones (the Firebase web config only when Firebase is the
 * switched-on SMS option), and whether checkout takes cards (with the Stripe
 * publishable key, which is public by design, and the card fee's percent), and the small-bag limit
 * of an order whose phone no code proved (so the bag can say it before the form is filled).
 * Nothing here is secret.
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
      bagLimit: bagLimitView(),
      // UAE VAT added on top at checkout: only when it is on with prices excluding VAT (nothing otherwise).
      ...(vatAddedPercent() ? { vat: { addedPercent: vatAddedPercent() } } : {}),
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

/**
 * The small bag of an order whose phone no code proved (src/lib/server/orders.ts refuses a bigger
 * one): every order with Phone check "WhatsApp (free)", card orders only when no SMS code is sent
 * for them, else none. The numbers are the server's own, so the bag and the refusal always agree.
 */
function bagLimitView() {
  const applies = phoneCheckMode() === 'whatsapp' ? 'all' : cardPaymentsReady(getSettings('payments')) && !phoneCodesOn() ? 'card' : null;
  return applies ? { applies, perItem: MAX_UNVERIFIED_CARD_QTY, lines: MAX_UNVERIFIED_CARD_LINES } : null;
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
