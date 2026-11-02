import { confirmOwner } from '@/lib/server/adminAuth';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { GO_LIVE_PHRASE, goLive, goLivePreview } from '@/lib/server/goLive';

/** Settings → System & backups → Go live: what would be removed (and what stops it). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ success: true, ...goLivePreview() });
  } catch (err) {
    return handleRouteError(err, 'admin/go-live');
  }
}

/**
 * Go live: the test orders removed for good (src/lib/server/goLive.ts). The owner's current password
 * every time (a passkey sign-in is not enough: this removes data), and the phrase typed.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['confirm', 'currentPassword', 'chats']);
    if (body.confirm !== GO_LIVE_PHRASE) throw new HttpError(400, `Type ${GO_LIVE_PHRASE} to confirm.`);
    if (body.chats !== undefined && typeof body.chats !== 'boolean') throw new HttpError(400, 'Customer chats: remove them or not.');
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: false });
    return json({ success: true, ...(await goLive({ chats: body.chats === true }, session.email)) });
  } catch (err) {
    return handleRouteError(err, 'admin/go-live');
  }
}
