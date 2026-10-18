import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { dismissPhoneCheckNotice } from '@/lib/server/settings';

/** "Got it" on the hub's one-time notice "Customers now confirm on WhatsApp instead of an SMS code". No body. */
export async function DELETE(req: Request) {
  try {
    await requireAdmin(req);
    dismissPhoneCheckNotice();
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/notices/phone-check');
  }
}
