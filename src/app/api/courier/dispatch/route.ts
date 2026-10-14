import { createJeeblyShipment } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import { audit } from '@/lib/server/audit';
import { parseCourierProvider, parseCourierSettings, parseOrderForDispatch } from '@/lib/server/courierInput';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

// One booking per order at a time: a double click must not book twice.
const inFlight = new Set<string>();

export async function POST(request: Request) {
  let orderId = '';
  try {
    const session = await requireAdmin(request);
    const body = await readJsonBody(request, 256 * 1024);
    const provider = parseCourierProvider(body.provider);
    const order = parseOrderForDispatch(body.order);
    const settings = parseCourierSettings(body.settings);

    if (inFlight.has(order.id)) {
      return json({ success: false, message: 'This order is already being booked. Please wait.' }, 409);
    }
    orderId = order.id;
    inFlight.add(orderId);

    const result = provider === 'jeebly'
      ? await createJeeblyShipment(order, settings.jeebly)
      : await createEchoShipment(order, settings.echo);

    audit('courier.dispatch', {
      by: session.email,
      orderId: order.id,
      provider,
      success: result.success,
      simulated: result.isSimulated,
      awb: result.awbNumber,
    });
    const { rawResponse: _raw, ...safe } = result as typeof result & { rawResponse?: unknown };
    void _raw;
    return json(safe, result.success ? 200 : 502);
  } catch (error) {
    return handleRouteError(error, 'courier/dispatch');
  } finally {
    if (orderId) inFlight.delete(orderId);
  }
}
