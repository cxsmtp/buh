import { cancelDriveConnect, pollDriveConnect, startDriveConnect } from '@/lib/server/driveBackup';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/**
 * "Connect my Google Drive" (OAuth 2.0 device flow):
 * - { action: 'start', clientId?, clientSecret? }: Google's code for the owner to enter (blank ones from the saved client);
 * - { action: 'poll' }: the hub asks every few seconds; the server asks Google no sooner than Google's interval;
 * - { action: 'cancel' }.
 * Never answers with the secret, the device code or a token.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4 * 1024);
    const { action, ...rest } = body;
    if (action === 'start') {
      enforceLimit('drive-connect-start', 20, 3600_000, 'Too many connection attempts in the last hour. Please wait a while and try again.');
      return json({ success: true, outcome: 'pending', status: await startDriveConnect(rest, session.email) });
    }
    if (Object.keys(rest).length) throw new HttpError(400, `Unexpected field: ${Object.keys(rest)[0].slice(0, 40)}.`);
    if (action === 'poll') {
      enforceLimit('drive-connect-poll', 900, 3600_000, 'Too many checks in the last hour. Press Connect Google Drive again later.');
      const { outcome, status } = await pollDriveConnect(session.email);
      return json({ success: true, outcome, status });
    }
    if (action === 'cancel') return json({ success: true, outcome: 'none', status: cancelDriveConnect(session.email) });
    throw new HttpError(400, 'action: start, poll or cancel.');
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive/connect');
  }
}
