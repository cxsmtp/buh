import { audit } from '@/lib/server/audit';
import { parseCourierProvider, parseCourierSettings } from '@/lib/server/courierInput';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { withStoredSecrets } from '@/lib/server/settings';
import { ECO_LIVE_NOT_CONNECTED } from '@/lib/courierMode';
import { callJeebly, JEEBLY_API, jeeblyLiveBase, jeeblyOk, jeeblySaid } from '@/lib/jeeblyApi';

/**
 * Admin-only "Test connection": asks Jeebly to track a made-up reference with the keys typed (or
 * saved), which creates nothing, and reports what Jeebly itself answered: the HTTP status and its
 * message, as text ("Invalid API Token" means the keys were refused). It never calls the keys good
 * unless Jeebly's reply says success. Eco Express is not connected (its spec points at a mock
 * server), so nothing is sent there.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const body = await readJsonBody(request, 16 * 1024);
    const provider = parseCourierProvider(body.provider);

    if (provider === 'echo') {
      audit('courier.test', { by: session.email, provider, reached: false, connected: false });
      return json({ success: false, provider: 'Eco Express', reached: false, connected: false, summary: ECO_LIVE_NOT_CONNECTED });
    }

    const settings = parseCourierSettings(withStoredSecrets('courier', body.settings)).jeebly;
    // Which keys: the ones asked for ("Test live keys" works before Live mode is on, as nothing is
    // booked); without a choice, the live keys in Live mode and the sandbox keys otherwise.
    if (body.target !== undefined && body.target !== 'live' && body.target !== 'sandbox') throw new HttpError(400, 'Test the live or the sandbox keys.');
    const target: 'live' | 'sandbox' = body.target === 'live' || body.target === 'sandbox' ? body.target : settings.isLive ? 'live' : 'sandbox';
    const base = target === 'live' ? jeeblyLiveBase(settings.liveBaseUrl) : JEEBLY_API.sandboxBase;
    const keys = target === 'live' ? { apiKey: settings.apiKey, clientKey: settings.clientKey } : { apiKey: settings.sandboxApiKey, clientKey: settings.sandboxClientKey };
    const where = target === 'live' ? 'Jeebly (live)' : "Jeebly's sandbox";
    if (!base || !keys.apiKey || !keys.clientKey) {
      const summary = !base ? `Add Jeebly's live address first (${JEEBLY_API.liveBaseExample}/customer/create_shipment, as Jeebly gives it).` : target === 'live' ? 'Add both live keys first.' : 'Add both sandbox keys first.';
      return json({ success: false, provider: 'Jeebly', target, reached: false, summary });
    }

    const startTime = Date.now();
    const call = await callJeebly(base, JEEBLY_API.paths.track, keys, { reference_number: 'CONNECTION-TEST' }, 10_000);
    const said = call.reached ? jeeblySaid(call.data, [keys.apiKey, keys.clientKey]) : '';
    const carrierSaysOk = call.reached && jeeblyOk(call.data);
    // A made-up reference is never found, so Jeebly answers "Invalid Customer Key Or Shipment Number"
    // even to good keys; refused keys get "Invalid API Token" (or the headers message) instead.
    const keysRefused = /invalid api token|headers are required/i.test(said);
    const keysAccepted = call.reached && !keysRefused && (call.status ?? 500) < 500;
    audit('courier.test', { by: session.email, provider, target, reached: call.reached, httpStatus: call.status ?? null, carrierSaysOk });

    return json({
      success: call.reached,
      provider: 'Jeebly',
      target,
      endpoint: `${base}${JEEBLY_API.paths.track}`,
      reached: call.reached,
      httpStatus: call.status ?? null,
      carrierMessage: said,
      carrierSaysOk,
      keysAccepted,
      latency: `${Date.now() - startTime}ms`,
      summary: call.reached
        ? keysRefused
          ? `Reached ${where} (HTTP ${call.status}): the keys were refused. Jeebly said: ${said || '(no message)'}`
          : keysAccepted
            ? `Reached ${where} (HTTP ${call.status}): the API key was accepted. Jeebly said: ${said || '(no message)'}${/customer key or shipment/i.test(said) ? ' (expected: the test asks for a shipment that does not exist; if the client key were wrong Jeebly gives the same answer, so the first real booking confirms it).' : ''} Nothing was booked.`
            : `Reached ${where} (HTTP ${call.status}); Jeebly said: ${said || '(no message)'}`
        : `Could not reach ${where} from the server (${call.error}).`,
    });
  } catch (error) {
    return handleRouteError(error, 'courier/test');
  }
}
