import { cookies } from 'next/headers';
import { clearedSessionCookie, endAllSessions, SESSION_COOKIE, verifySessionToken } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { assertSameOrigin, handleRouteError, json } from '@/lib/server/http';
import { requireDoor } from '@/lib/server/guard';
import { endAllStaffSessions, endStaffSessions } from '@/lib/server/staffAuth';

/**
 * Sign out everywhere: the session generation is bumped, so copied cookies stop working too. The
 * owner's also signs every accountant out; an accountant's signs out only themselves.
 */
export async function POST(req: Request) {
  try {
    requireDoor(req);
    assertSameOrigin(req);
    const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
    if (session?.role === 'accountant' && session.staffId) {
      // An accountant signs only themselves out (every device), never the owner.
      endStaffSessions(session.staffId);
      audit('accountant.sign_out', { by: session.email });
    } else if (session) {
      // The owner: every session ends, the accountants' too.
      endAllSessions();
      const staff = endAllStaffSessions();
      audit('admin.sign_out', { email: session.email, ...(staff ? { accountantsSignedOut: staff } : {}) });
    }
    const res = json({ success: true });
    res.cookies.set(clearedSessionCookie());
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/logout');
  }
}
