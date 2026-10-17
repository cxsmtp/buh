import { confirmOwner, isFreshPasskeySession } from '@/lib/server/adminAuth';
import { currentLink, doorCookie, issueDoorToken, linkNotice, linkUrl } from '@/lib/server/adminLink';
import { changeAdminLink } from '@/lib/server/adminLinkSetup';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { emailConfigured } from '@/lib/server/mail';
import { siteUrl } from '@/lib/server/siteUrl';

/** Settings → Security: when the admin link was made, and whether the hub should say "bookmark this page". Never the link. */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    const rec = currentLink();
    return json({ createdAt: rec?.createdAt ?? null, via: rec?.via ?? null, notice: linkNotice(), freshPasskey: isFreshPasskeySession(session), emailConfigured: emailConfigured() });
  } catch (err) {
    return handleRouteError(err, 'admin/link');
  }
}

/**
 * "Change the admin link": the current password, or a passkey sign-in in the last 10
 * minutes. The old link and every door cookie stop working at once; this browser gets
 * a door for the new link. The new link is in this answer only (and emailed to the
 * admin email when email is set up); the server keeps a fingerprint of it.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['currentPassword']);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: true });
    const base = await siteUrl();
    const { segment, emailing } = changeAdminLink({ ip: clientIp(req), base });
    const res = json({ success: true, link: linkUrl(segment, base), path: `/${segment}`, emailing });
    const token = issueDoorToken();
    if (token) res.cookies.set(doorCookie(token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/link/change');
  }
}
