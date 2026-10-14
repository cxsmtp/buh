import { clearedSessionCookie } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { assertSameOrigin, handleRouteError, json } from '@/lib/server/http';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    audit('admin.sign_out');
    const res = json({ success: true });
    res.cookies.set(clearedSessionCookie());
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/logout');
  }
}
