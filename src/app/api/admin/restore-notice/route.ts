import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { dismissRestoreNotice, restoreNotice } from '@/lib/server/passkeys';
import { recoveryCodeStatus } from '@/lib/server/recoveryCodes';

/** After a restore: when it happened and what is still to review (banner in the Admin Hub). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const notice = restoreNotice();
    return json({ notice: notice ? { ...notice, recoveryCodesLeft: recoveryCodeStatus().remaining } : null });
  } catch (err) {
    return handleRouteError(err, 'admin/restore-notice');
  }
}

/** "Done": hide the banner. Passkeys still switched off stay switched off. */
export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin(req);
    dismissRestoreNotice();
    audit('admin.restore_reviewed', { email: session.email });
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/restore-notice/dismiss');
  }
}
