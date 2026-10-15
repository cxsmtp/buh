import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { changelog, labelOf, OLDEST_ROLLBACK, pendingRequest, requestSwitch, updaterStatus, versionOf } from '@/lib/server/versions';

/** Settings → Versions: this build, the changelog, and what the updater reports. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({
      current: versionOf(process.env.NEXT_PUBLIC_APP_VERSION || 'BUH-00.00.00'),
      oldestRollback: OLDEST_ROLLBACK,
      changelog: changelog(),
      updater: updaterStatus(),
      pending: pendingRequest(),
    });
  } catch (err) {
    return handleRouteError(err, 'admin/versions');
  }
}

/** { target: "2.0.1" | "latest" }: the updater switches without closing the shop. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'versions', 10, 60 * 60 * 1000, 'Too many version switches. Try again later.');
    const body = await readJsonBody(req, 512);
    const target = str(body.target, 'Version', 20);
    const line = requestSwitch(target);
    audit('system.version_switch_requested', { by: session.email, request: line, from: process.env.NEXT_PUBLIC_APP_VERSION, ip: clientIp(req) });
    return json({
      success: true,
      message:
        target === 'latest'
          ? 'Asked for the latest version. The new copy starts beside this one and takes over when healthy (about a minute); this page then reloads by itself.'
          : `Asked to switch to ${labelOf(target)}. It starts beside this one and takes over when healthy (about a minute); a database snapshot is taken first.`,
    });
  } catch (err) {
    return handleRouteError(err, 'admin/versions/switch');
  }
}
