import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { revokeStaff } from '@/lib/server/staffAuth';

/** Revoke an accountant's access (owner only): their sessions and any setup link end at once. Audited first. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    return json({ success: true, account: revokeStaff(id, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/staff/[id]');
  }
}
