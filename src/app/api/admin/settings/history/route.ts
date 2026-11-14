import { audit } from '@/lib/server/audit';
import { CONFIRMED_SETTINGS, confirmOwnerForChange, sessionCookie } from '@/lib/server/adminAuth';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { auditPaymentOptions, paymentOptions } from '@/lib/server/payments';
import { restoreSettingsVersion, settingsHistory, settingsVersionKey } from '@/lib/server/settings';

/** Earlier versions of the settings (keys are never kept in history). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ versions: settingsHistory() });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/history');
  }
}

/** Restore one: { id }. The version it replaces is kept too, so a restore can be undone. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    if (!Number.isInteger(body.id) || (body.id as number) < 1) throw new HttpError(400, 'Give the version id.');
    // Putting back an earlier bank account, payment, SMS or email settings is a save of that group:
    // the owner again (see the settings route).
    let confirmed: { token?: string } = {};
    if (CONFIRMED_SETTINGS.includes(settingsVersionKey(body.id as number) ?? '')) {
      if (body.currentPassword) enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
      confirmed = await confirmOwnerForChange(session, body.currentPassword, { ip: clientIp(req) });
    }
    const optionsBefore = paymentOptions();
    const key = await restoreSettingsVersion(body.id as number, session.email);
    audit('settings.restored', { by: session.email, key, versionId: body.id });
    if (key === 'payments') auditPaymentOptions(optionsBefore, session.email);
    const res = json({ success: true, key });
    if (confirmed.token) res.cookies.set(sessionCookie(confirmed.token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/settings/history/restore');
  }
}
