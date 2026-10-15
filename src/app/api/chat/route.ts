import { startChat } from '@/lib/server/chat';
import { clientIp, enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody } from '@/lib/server/http';

/** Start a chat: { message, name?, contact?, page? } → the conversation and its secret (kept by the browser). */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'chat-start', 6, 60 * 60 * 1000, 'Too many new chats from this address. Please message us on WhatsApp or by email.');
    enforceLimit('chat-start:all', 300, 60 * 60 * 1000, 'The chat is very busy right now. Please message us on WhatsApp or by email.');
    const body = await readJsonBody(req, 4 * 1024);
    return json(startChat({ message: body.message, name: body.name, contact: body.contact, page: body.page, ip: clientIp(req) }));
  } catch (err) {
    return handleRouteError(err, 'chat/start');
  }
}
