import { listChats, waitingCount } from '@/lib/server/chat';
import { mailboxStatus } from '@/lib/server/chatMail';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';

/** Admin Hub → Chats: conversations, newest first (?filter=all includes closed ones). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const filter = new URL(req.url).searchParams.get('filter') === 'all' ? 'all' : 'open';
    return json({ chats: listChats(filter), waiting: waitingCount(), mailbox: mailboxStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/chats');
  }
}
