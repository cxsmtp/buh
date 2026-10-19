import { audit } from '@/lib/server/audit';
import { parseCourierProvider, parseCourierSettings } from '@/lib/server/courierInput';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
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
    // Live mode tests the live keys at the live address; otherwise the sandbox keys on Jeebly's demo system.
    const target = settings.isLive ? 'live' : 'sandbox';
    const base = target === 'live' ? jeeblyLiveBase(settings.liveBaseUrl) : JEEBLY_API.sandboxBase;
    const keys = target === 'live' ? { apiKey: settings.apiKey, clientKey: settings.clientKey } : { apiKey: settings.sandboxApiKey, clientKey: settings.sandboxClientKey };
    const where = target === 'live' ? 'Jeebly (live)' : "Jeebly's sandbox";
    if (!base || !keys.apiKey || !keys.clientKey) {
      const summary = !base ? "Add Jeebly's live address first (https, on jeebly.com)." : target === 'live' ? 'Add both live keys first.' : 'Add both sandbox keys first (Live mode is off, so the sandbox keys are tested).';
      return json({ success: false, provider: 'Jeebly', target, reached: false, summary });
    }

    const startTime = Date.now();
    const call = await callJeebly(base, JEEBLY_API.paths.track, keys, { reference_number: 'CONNECTION-TEST' }, 10_000);
    const said = call.reached ? jeeblySaid(call.data, [keys.apiKey, keys.clientKey]) : '';
    const carrierSaysOk = call.reached && jeeblyOk(call.data);
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
      latency: `${Date.now() - startTime}ms`,
      summary: call.reached
        ? `Reached ${where} (HTTP ${call.status}); Jeebly said: ${said || '(no message)'}${/invalid api token/i.test(said) ? ' — the keys were refused.' : ''}`
        : `Could not reach ${where} from the server (${call.error}).`,
    });
  } catch (error) {
    return handleRouteError(error, 'courier/test');
  }
}
