import { adminAccountInfo } from '@/lib/server/adminAuth';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';
import { emailStaffInvite, inviteAccountant, listStaff } from '@/lib/server/staffAuth';

/** Settings → Security → Accountant access: who has read-only access (owner only). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ accounts: listStaff() });
  } catch (err) {
    return handleRouteError(err, 'admin/staff');
  }
}

/**
 * Invite an accountant, or send one a new setup link: { email, name? }. The one-time link (72 hours)
 * is emailed when the shop's email is set up; otherwise it comes back here once, for the owner to
 * pass on themselves (it is never stored: only its hashes are).
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceLimit(`staff-invite:${session.email}`, 10, 60 * 60_000, 'Too many invitations. Try again in an hour.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['email', 'name']);
    const owner = await adminAccountInfo();
    const base = await siteUrl();
    const invite = inviteAccountant(body.email, body.name, owner.email, session.email);
    const link = `${base}/${invite.grant}#setup=${encodeURIComponent(invite.token)}`;
    const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
    const emailed = await emailStaffInvite(invite.account.email, link, shop, owner.email);
    return json({ success: true, account: invite.account, emailed, ...(emailed ? {} : { link }) });
  } catch (err) {
    return handleRouteError(err, 'admin/staff');
  }
}
