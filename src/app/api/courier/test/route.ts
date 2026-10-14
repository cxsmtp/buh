import { audit } from '@/lib/server/audit';
import { parseCourierProvider, parseCourierSettings } from '@/lib/server/courierInput';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { safeFetch } from '@/lib/server/outbound';
import { withStoredSecrets } from '@/lib/server/settings';

function masked(secret: string) {
  return secret ? `••••${secret.slice(-4)}` : '(not set)';
}

/** Admin-only: check that the carrier endpoint answers with the entered credentials. */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const body = await readJsonBody(request, 16 * 1024);
    const provider = parseCourierProvider(body.provider);
    const settings = parseCourierSettings(withStoredSecrets('courier', body.settings));

    // Endpoints are fixed here, never taken from the request.
    const endpoint = provider === 'jeebly'
      ? settings.jeebly.isLive
        ? 'https://portal.jeebly.com/customer/create_shipment'
        : 'https://demo.jeebly.com/customer/create_shipment'
      : 'https://private-anon-c02b65ac7e-ecoexpress.apiary-mock.com/connect/client/order/shipment/create';
    const headers: Record<string, string> = provider === 'jeebly'
      ? { 'Content-Type': 'application/json', XApiKey: settings.jeebly.apiKey || 'test', ClientKey: settings.jeebly.clientKey || 'test' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.echo.apiKey || 'test_token'}` };

    const startTime = Date.now();
    let httpStatus: number | null = null;
    try {
      const res = await safeFetch(endpoint, { method: 'POST', headers, body: '{}', timeoutMs: 10_000, maxBytes: 16 * 1024 });
      httpStatus = res.status;
    } catch {
      httpStatus = null;
    }
    audit('courier.test', { by: session.email, provider, httpStatus });

    return json({
      success: httpStatus !== null,
      provider: provider === 'jeebly' ? 'Jeebly Logistics UAE' : 'Eco Express Courier Services',
      endpoint,
      status: httpStatus === null ? 'OFFLINE' : httpStatus === 200 ? 'LIVE_ENDPOINT_ACTIVE' : 'REACHABLE',
      httpStatus,
      latency: `${Date.now() - startTime}ms`,
      serverVerified: httpStatus !== null,
      note: httpStatus === null
        ? 'The carrier endpoint could not be reached from the server.'
        : 'Carrier endpoint reached over HTTPS.',
      sampleRequestHeaders: provider === 'jeebly'
        ? { XApiKey: masked(settings.jeebly.apiKey), ClientKey: masked(settings.jeebly.clientKey), 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${masked(settings.echo.apiKey)}`, 'X-Account-Id': settings.echo.accountId || '(not set)', 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return handleRouteError(error, 'courier/test');
  }
}
