import { NextRequest } from 'next/server';
import { liveGateways, sendRealSmsOtp } from '@/lib/otpService';
import { assertSameOrigin, clientIp, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { phoneCheckMode } from '@/lib/server/settings';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    // Settings → Phone check "WhatsApp (free)": checkout sends no codes, so neither does this (no
    // SMS can be pumped through a gateway that is still saved). A page from before says to reload.
    if (phoneCheckMode() === 'whatsapp') {
      throw new HttpError(409, 'We now confirm orders on WhatsApp: no code is needed. Please reload the page and place your order.', {}, { code: 'phone_codes_off' });
    }
    const body = await readJsonBody(req, 2 * 1024);
    // Gateway settings in the body are ignored: the public endpoint only uses
    // the server's own configuration, so callers cannot pick where codes go.
    const result = await sendRealSmsOtp(String(body.phone ?? ''), { gateways: await liveGateways(), ip: clientIp(req) });
    return json(result, result.success ? 200 : 503);
  } catch (error) {
    return handleRouteError(error, 'otp/send', { success: false });
  }
}
