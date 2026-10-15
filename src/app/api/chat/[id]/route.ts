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
    const after = new URL(req.url).searchParams.get('after');
    return json(customerPoll(id, req.headers.get('x-chat-token'), after));
  } catch (err) {
    return handleRouteError(err, 'chat/poll');
  }
}

/** { token, action: "send" | "person" | "contact", message?, name?, contact? } */
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
        return json(customerSend(id, body.token, body.message, body.after));
      case 'person':
        return json(customerAskPerson(id, body.token, body.after));
      case 'contact':
        return json(customerContact(id, body.token, { name: body.name, contact: body.contact }, body.after));
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    return handleRouteError(err, 'chat/message');
  }
}
