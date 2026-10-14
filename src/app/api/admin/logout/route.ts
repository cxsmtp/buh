import { cookies } from 'next/headers';
import { clearedSessionCookie, endAllSessions, SESSION_COOKIE, verifySessionToken } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { assertSameOrigin, handleRouteError, json } from '@/lib/server/http';

/** Sign out everywhere: the session generation is bumped, so copied cookies stop working too. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
    if (session) {
      endAllSessions();
      audit('admin.sign_out', { email: session.email });
    }
    const res = json({ success: true });
    res.cookies.set(clearedSessionCookie());
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/logout');
  }
}
