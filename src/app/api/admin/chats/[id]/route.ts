import { adminReply, chatForAdmin, setChatStatus } from '@/lib/server/chat';
import { enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

const checkId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new HttpError(404, 'No such chat.');
  return id;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    return json(chatForAdmin(checkId((await params).id)));
  } catch (err) {
    return handleRouteError(err, 'admin/chats/get');
  }
}

/** Reply: { message }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'chat-reply', 120, 10 * 60 * 1000, 'Too many replies. Wait a moment.');
    const body = await readJsonBody(req, 8 * 1024);
    const message = adminReply(checkId((await params).id), body.message, 'admin', session.email);
    return json({ success: true, message });
  } catch (err) {
    return handleRouteError(err, 'admin/chats/reply');
  }
}

/** { status: "closed" | "bot" | "human" }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    return json({ success: true, thread: setChatStatus(checkId((await params).id), body.status, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/chats/status');
  }
}
