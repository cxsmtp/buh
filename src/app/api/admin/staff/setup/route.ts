import { sessionCookie } from '@/lib/server/adminAuth';
import { doorCookie, issueDoorToken } from '@/lib/server/adminLink';
import { auditOrThrow } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireDoor } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { passwordProblem } from '@/lib/server/password';
import { completeStaffSetup, staffSessionToken } from '@/lib/server/staffAuth';

/**
 * The accountant's setup link: { token, password }. Reached only through the door (the link's own
 * grant opens it, like a password-reset email's). Works once, within 72 hours; signs the accountant
 * in (read-only), audited.
 */
export async function POST(req: Request) {
  try {
    requireDoor(req);
    assertSameOrigin(req);
    enforceIpLimit(req, 'staff-setup', 10, 60 * 60 * 1000, 'Too many attempts from this address. Try again in an hour.');
    const body = await readJsonBody(req, 2048);
    allowFields(body, ['token', 'password']);
    const token = str(body.token, 'Setup link', 100);
    const password = str(body.password, 'Password', 256, { trim: false });
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem);
    const staff = await completeStaffSetup(token, password);
    auditOrThrow('accountant.sign_in', { by: staff.email, ip: clientIp(req), via: 'setup' });
    const res = json({ success: true, email: staff.email, role: 'accountant' });
    res.cookies.set(sessionCookie(staffSessionToken(staff)));
    // The setup link's door ends with it: this browser keeps the hub's ordinary door (30 days, renewed while used).
    const door = issueDoorToken();
    if (door) res.cookies.set(doorCookie(door));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/staff/setup');
  }
}
