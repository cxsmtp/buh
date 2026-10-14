import { NextRequest } from 'next/server';
import { envGateways, sendRealSmsOtp } from '@/lib/otpService';
import { assertSameOrigin, clientIp, handleRouteError, json, readJsonBody } from '@/lib/server/http';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const body = await readJsonBody(req, 2 * 1024);
    // Gateway settings in the body are ignored: the public endpoint only uses
    // the server's own configuration, so callers cannot pick where codes go.
    const result = await sendRealSmsOtp(String(body.phone ?? ''), { gateways: envGateways(), ip: clientIp(req) });
    return json(result, result.success ? 200 : 503);
  } catch (error) {
    return handleRouteError(error, 'otp/send', { success: false });
  }
}
