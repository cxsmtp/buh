import { LIVE_OVERRIDE_PHRASE } from '@/lib/courierMode';
import { audit, auditOrThrow } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { adminView, sandboxCheckFresh, updateSettings } from '@/lib/server/settings';

/**
 * Admin: switch Jeebly Live mode on or off. On needs a passed Sandbox check within 30 days (the
 * settings save itself refuses otherwise), or the owner's override: the typed phrase, audited
 * before Live mode is switched on.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['on', 'override']);
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false.');
    let override = false;
    if (body.on && body.override !== undefined) {
      if (body.override !== LIVE_OVERRIDE_PHRASE) throw new HttpError(400, `To turn Live mode on without a Sandbox check, type ${LIVE_OVERRIDE_PHRASE} exactly.`, {}, { code: 'override_phrase' });
      override = !sandboxCheckFresh();
      if (override) auditOrThrow('courier.live_override', { by: session.email, provider: 'jeebly', reason: 'turned on without a passed sandbox check' });
    }
    await updateSettings('courier', { jeebly: { isLive: body.on } }, { liveOverride: override });
    audit('courier.live', { by: session.email, provider: 'jeebly', on: body.on, override });
    return json({ success: true, ...adminView('courier') });
  } catch (err) {
    return handleRouteError(err, 'courier/live');
  }
}
