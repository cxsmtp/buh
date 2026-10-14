import { audit } from '@/lib/server/audit';
import { parseCourierProvider, parseCourierSettings, parseOrderForDispatch } from '@/lib/server/courierInput';
import { dispatchOrder } from '@/lib/server/dispatch';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const body = await readJsonBody(request, 256 * 1024);
    const provider = parseCourierProvider(body.provider);
    const order = parseOrderForDispatch(body.order);
    const settings = parseCourierSettings(body.settings);
    // true once the owner has checked the carrier portal after an unanswered attempt
    const rebook = body.rebook === true;

    const outcome = await dispatchOrder({ provider, order, settings, rebook });
    if (outcome.attempt) {
      audit('courier.dispatch', { by: session.email, orderId: order.id, provider, live: settings[provider].isLive, rebook, ...outcome.attempt });
    }
    return json(outcome.body, outcome.status);
  } catch (error) {
    return handleRouteError(error, 'courier/dispatch');
  }
}
