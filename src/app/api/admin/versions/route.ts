import { audit } from '@/lib/server/audit';
import { runBackup } from '@/lib/server/backup';
import { pendingChanges } from '@/lib/server/dataChanges';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { changelog, labelOf, OLDEST_ROLLBACK, pendingRequest, requestAuto, requestSwitch, updaterStatus, versionOf } from '@/lib/server/versions';

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

/**
 * { target: "2.0.1" | "latest" }: the updater switches without closing the shop.
 * { auto: true | false }: new versions are installed by themselves, or only when asked.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'versions', 10, 60 * 60 * 1000, 'Too many version requests. Try again later.');
    const body = await readJsonBody(req, 512);
    const keys = Object.keys(body);
    if (keys.length !== 1 || !['target', 'auto'].includes(keys[0])) throw new HttpError(400, 'Send either a version or the automatic-install setting.');
    if (keys[0] === 'auto') {
      if (typeof body.auto !== 'boolean') throw new HttpError(400, 'The automatic-install setting is on or off.');
      const line = requestAuto(body.auto);
      audit('system.auto_update_changed', { by: session.email, request: line, ip: clientIp(req) });
      return json({
        success: true,
        message: body.auto ? 'New versions will be installed by themselves (the updater confirms within a minute).' : 'New versions will be installed only when you ask (the updater confirms within a minute).',
      });
    }
    const target = str(body.target, 'Version', 20);
    // Changes waiting for their backup go first (off the server too), at most a minute; the updater's
    // own snapshot before the switch holds them on the server either way.
    if (pendingChanges().total > 0) await Promise.race([runBackup('changes'), new Promise((r) => setTimeout(r, 60_000).unref())]);
    const line = requestSwitch(target);
    audit('system.version_switch_requested', { by: session.email, request: line, from: process.env.NEXT_PUBLIC_APP_VERSION, ip: clientIp(req) });
    const what = target === 'latest' ? 'Asked for the latest version.' : `Asked to switch to ${labelOf(target)}; a database snapshot is taken first.`;
    // One container (Podman): the new version is tried beside this one, then replaces it with a short pause.
    const how =
      updaterStatus()?.mode === 'single'
        ? 'It is tried beside this one first (about a minute), then replaces it: the shop is closed for a few seconds. Reload this page afterwards.'
        : 'The new copy starts beside this one and takes over when healthy (about a minute); this page then reloads by itself.';
    return json({ success: true, message: `${what} ${how}` });
  } catch (err) {
    return handleRouteError(err, 'admin/versions/switch');
  }
}
