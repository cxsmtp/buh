import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/server/adminAuth';
import { handleRouteError, json } from '@/lib/server/http';

export async function GET() {
  try {
    const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
    if (!session) return json({ authenticated: false });
    return json({
      authenticated: true,
      email: session.email,
      mustChangePassword: session.mustChangePassword,
      // Signed in with a recovery code: the next step is choosing a new password.
      recoveryPending: session.recoveryPending,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    return handleRouteError(err, 'admin/session', { authenticated: false });
  }
}
