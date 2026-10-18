import { enforceIpLimit, enforceLimit, requireDoor } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';

/**
 * The Admin Hub's error screen reports what broke: { message, stack?, where? } goes to the
 * server's log (logEvent masks keys, phones, emails and the link), so a crash seen on the
 * owner's phone can be found with `podman logs beautifuluaehome`. Only from a browser with the
 * door (signed in or not: a crash can come before signing in), a few per hour.
 */
export async function POST(req: Request) {
  try {
    requireDoor(req);
    assertSameOrigin(req);
    enforceIpLimit(req, 'hub-error', 20, 60 * 60 * 1000, 'Too many reports.');
    enforceLimit('hub-error:all', 200, 60 * 60 * 1000, 'Too many reports.');
    const body = await readJsonBody(req, 8 * 1024);
    allowFields(body, ['message', 'stack', 'where']);
    logEvent('error', 'hub_client_error', {
      message: str(body.message, 'message', 500),
      stack: str(body.stack, 'stack', 3000, { required: false }),
      where: str(body.where, 'where', 60, { required: false }),
      userAgent: (req.headers.get('user-agent') || '').slice(0, 200),
    });
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/client-error');
  }
}
