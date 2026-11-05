import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { s3Status, updateS3Settings } from '@/lib/server/s3Backup';

/** Settings → System & backups → S3-compatible storage: the setup (never the secret: whether it is saved, its last 4). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(s3Status());
  } catch (err) {
    return handleRouteError(err, 'admin/backup/s3');
  }
}

/** Save: { enabled?, endpoint?, region?, bucket?, prefix?, keep?, accessKeyId?, secretAccessKey?, forget? } (allow-listed and checked). */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4 * 1024);
    return json(await updateS3Settings(body, session.email));
  } catch (err) {
    return handleRouteError(err, 'admin/backup/s3/save');
  }
}
