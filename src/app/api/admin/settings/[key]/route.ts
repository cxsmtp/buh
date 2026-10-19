import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { auditPaymentOptions, paymentOptions, paymentsModeWarning } from '@/lib/server/payments';
import { adminView, getSettings, undoVersionId, type SettingsKey } from '@/lib/server/settings';
import { saveGuarded } from '@/lib/server/settingsGuard';

const KEYS: SettingsKey[] = ['brand', 'bank', 'courier', 'sms', 'catalog', 'store', 'theme', 'email', 'assistant', 'delivery', 'payments', 'phoneCheck', 'ai'];

export async function PUT(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { key } = await params;
    if (!KEYS.includes(key as SettingsKey)) throw new HttpError(404, 'Unknown settings.');
    // Branding may carry a logo image (stored as a file).
    const body = await readJsonBody(req, key === 'brand' ? 4 * 1024 * 1024 : 64 * 1024);
    const keyBefore = key === 'payments' ? getSettings('payments').stripeSecretKey : '';
    const optionsBefore = key === 'payments' ? paymentOptions() : null;
    // Validated, and tried first where possible: a change that fails keeps the working settings.
    const result = await saveGuarded(key as SettingsKey, body.settings, undefined, { auto: body.auto === true });
    // Keys of another Stripe mode while card orders are open: said, not blocked.
    const warning = key === 'payments' ? paymentsModeWarning(keyBefore, getSettings('payments').stripeSecretKey) : null;
    // Field names only: never the values (they may be keys).
    audit('settings.updated', { by: session.email, key, fields: Object.keys((body.settings as object) || {}), auto: body.auto === true, verified: result.verified });
    // The card fee and the bank-transfer choice change what customers pay and see: from and to.
    if (optionsBefore) auditPaymentOptions(optionsBefore, session.email);
    return json({ success: true, ...result, undoId: undoVersionId(key as SettingsKey), ...adminView(key as SettingsKey), ...(warning ? { warning } : {}) });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/update');
  }
}
