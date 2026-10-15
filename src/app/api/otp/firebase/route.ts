import { NextRequest } from 'next/server';
import { confirmFirebasePhone } from '@/lib/server/firebasePhone';
import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody } from '@/lib/server/http';

/**
 * Firebase Phone Authentication: the browser signed in with Firebase by SMS
 * and sends its ID token. Answers like /api/otp/verify, with the signed phone
 * token that /api/orders requires.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'otp:firebase', 30, 15 * 60 * 1000, 'Too many attempts. Please wait a few minutes.');
    // A Firebase ID token is about 1 KB; nothing else is read from the body.
    const body = await readJsonBody(req, 8 * 1024);
    return json(await confirmFirebasePhone(body.idToken));
  } catch (error) {
    return handleRouteError(error, 'otp/firebase', { valid: false });
  }
}
