import { requireAdmin, requireReader } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { VAT_CONFIRM_PHRASE, saveVatSettings, vatInUse, vatSettings } from '@/lib/server/vat';

/** Settings → Payments → VAT as it stands (the owner, or the accountant: read-only; a TRN is printed on every invoice, it is not a secret). */
export async function GET(req: Request) {
  try {
    await requireReader(req);
    return json({ settings: vatSettings(), inUse: vatInUse(), confirmPhrase: VAT_CONFIRM_PHRASE });
  } catch (err) {
    return handleRouteError(err, 'admin/vat');
  }
}

/**
 * Save it (owner only): { enabled, trn, pricesIncludeVat, effectiveFrom, legalName, address, confirm }.
 * Turning it on needs the typed confirmation; every change is audited before it counts.
 */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4096);
    return json({ success: true, settings: saveVatSettings(body, session.email), inUse: vatInUse() });
  } catch (err) {
    return handleRouteError(err, 'admin/vat');
  }
}
