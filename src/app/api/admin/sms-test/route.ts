import { NextRequest } from 'next/server';
import { gatewaysFromSettings, sendRealSmsOtp } from '@/lib/otpService';
import { audit } from '@/lib/server/audit';
import { clientIp, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { SmsGatewaySettings } from '@/types';

/** Admin-only: send a test code through the gateway settings entered in the SMS tab. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 8 * 1024);
    const gateways = await gatewaysFromSettings(body.settings as Partial<SmsGatewaySettings> | undefined);
    const result = await sendRealSmsOtp(String(body.phone ?? ''), { gateways, ip: clientIp(req) });
    audit('sms.test_send', { by: session.email, provider: result.provider, success: result.success });
    return json(result, result.success ? 200 : 503);
  } catch (error) {
    return handleRouteError(error, 'admin/sms-test', { success: false });
  }
}
