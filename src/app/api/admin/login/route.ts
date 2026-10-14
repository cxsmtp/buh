import { signIn, sessionCookie } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';

export async function POST(req: Request) {
  const ip = clientIp(req);
  try {
    assertSameOrigin(req);
    // 30 attempts per 10 minutes per address, on top of the per-account lockout.
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many sign-in attempts from this address. Wait a few minutes.');

    const body = await readJsonBody(req, 4 * 1024);
    const email = str(body.email, 'Email', 254);
    const password = str(body.password, 'Password', 256, { trim: false });

    try {
      const result = await signIn(email, password, { ip });
      audit('admin.sign_in', { email: result.email, ip });
      const res = json({ success: true, email: result.email, mustChangePassword: result.mustChangePassword });
      res.cookies.set(sessionCookie(result.token));
      return res;
    } catch (err) {
      if (err instanceof HttpError) audit('admin.sign_in_refused', { email, ip, status: err.status });
      throw err;
    }
  } catch (err) {
    return handleRouteError(err, 'admin/login');
  }
}
