import { confirmOwner } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { checkTypedPassphrase, confirmGeneratedPassphrase, hubPassphraseSet, passphraseStatus, setTypedPassphrase, startGeneratedPassphrase, type SavedPassphrase } from '@/lib/server/backupSecret';
import { driveStatus, enableDriveIfWaiting } from '@/lib/server/driveBackup';
import { clientIp, enforceIpLimit, enforceLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';

/**
 * Settings → System & backups → "Protect backups with a password" (the owner only: an accountant
 * gets 403). Never answers with the password, except the one "Make one for me" reply (no-store).
 *
 * - GET: whether backups are encrypted, where the password comes from (the hub, or the server's
 *   BACKUP_PASSPHRASE, which wins), the day it was set and the earlier ones (fingerprints only).
 * - POST { action: 'generate' }: a new password, shown once; nothing changes yet.
 * - POST { action: 'confirm', fingerprint, currentPassword? }: "I saved it": the generated one
 *   (the one with that fingerprint, as shown) becomes the backup password.
 * - POST { action: 'set', passphrase, repeat }: the owner's own, when there is none yet.
 * - POST { action: 'change', passphrase, repeat, currentPassword }.
 * Replacing a password (confirm or change while one is set) needs the hub password again; each
 * change is audited (backup.passphrase_set / backup.passphrase_changed, never the value) before
 * the reply says it is done.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(passphraseStatus());
  } catch (err) {
    return handleRouteError(err, 'admin/backup/passphrase');
  }
}

const FIELDS: Record<string, readonly string[]> = {
  generate: ['action'],
  confirm: ['action', 'fingerprint', 'currentPassword'],
  set: ['action', 'passphrase', 'repeat'],
  change: ['action', 'passphrase', 'repeat', 'currentPassword'],
};

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    assertSameOrigin(req);
    enforceLimit('backup-passphrase', 30, 3600_000, 'Too many changes to the backup password in the last hour. Please wait a while and try again.');
    const body = await readJsonBody(req, 2 * 1024);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!FIELDS[action]) throw new HttpError(400, 'action: generate, confirm, set or change.');
    allowFields(body, FIELDS[action]);

    if (action === 'generate') {
      const made = await startGeneratedPassphrase(session.email);
      return json({ success: true, passphrase: made.passphrase, fingerprint: made.fingerprint, expiresAt: made.expiresAt });
    }

    // Replacing the password in use: the hub password again (a passkey sign-in is not enough).
    const replacing = hubPassphraseSet();
    if (action === 'set' && replacing) throw new HttpError(409, 'A backup password is already set: use Change the password.', {}, { code: 'passphrase_set' });
    if (replacing || action === 'change') {
      enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
      const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
      await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: false });
    }

    let saved: SavedPassphrase;
    if (action === 'confirm') saved = confirmGeneratedPassphrase(session.email, str(body.fingerprint, 'fingerprint', 12), replacing);
    else saved = await setTypedPassphrase(checkTypedPassphrase(body.passphrase, body.repeat), session.email, replacing);

    if (!audit(saved.changed ? 'backup.passphrase_changed' : 'backup.passphrase_set', { by: session.email, how: saved.how, fingerprint: saved.fingerprint })) throw new Error('audit write failed');
    // Google Drive connected while there was no password: copies switch on now.
    const driveSwitchedOn = enableDriveIfWaiting(session.email);
    return json({ success: true, status: passphraseStatus(), changed: saved.changed, driveSwitchedOn, drive: driveStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/backup/passphrase');
  }
}
