import { checkMailbox, mailboxStatus } from '@/lib/server/chatMail';
import { enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';

/** "Check the mailbox now" (it is also read every minute). */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    enforceIpLimit(req, 'chat-mail', 10, 10 * 60 * 1000, 'Checked a moment ago. Wait a little.');
    const posted = await checkMailbox();
    return json({ success: true, posted, mailbox: mailboxStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/chats/check-mail');
  }
}
