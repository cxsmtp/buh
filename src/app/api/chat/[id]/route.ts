import { customerAskPerson, customerContact, customerPoll, customerSend } from '@/lib/server/chat';
import { enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/**
 * The customer's own chat. The secret travels in a header (GET) or the body
 * (POST), never in the address, so it stays out of logs.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    enforceIpLimit(req, 'chat-poll', 600, 10 * 60 * 1000, 'Too many requests. Wait a moment.');
    const query = new URL(req.url).searchParams;
    // lang: the language the customer's page shows ("en" or "ar"; anything else is ignored).
    return json(customerPoll(id, req.headers.get('x-chat-token'), query.get('after'), Date.now(), query.get('lang')));
  } catch (err) {
    return handleRouteError(err, 'chat/poll');
  }
}

/** { token, action: "send" | "person" | "contact", message?, name?, contact?, locale? ("en" or "ar") } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    enforceIpLimit(req, 'chat-send', 40, 10 * 60 * 1000, 'You are sending messages very quickly. Wait a moment, please.');
    // Per chat as well (applies even when the client's address is unknown).
    enforceLimit(`chat-send:${String(id).slice(0, 40)}`, 40, 10 * 60 * 1000, 'You are sending messages very quickly. Wait a moment, please.');
    const body = await readJsonBody(req, 4 * 1024);
    switch (body.action) {
      case 'send':
        return json(customerSend(id, body.token, body.message, body.after, Date.now(), body.locale));
      case 'person':
        return json(customerAskPerson(id, body.token, body.after, Date.now(), body.locale));
      case 'contact':
        return json(customerContact(id, body.token, { name: body.name, contact: body.contact }, body.after, Date.now(), body.locale));
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    return handleRouteError(err, 'chat/message');
  }
}
