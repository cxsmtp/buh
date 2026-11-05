import { requireAdmin, enforceLimit } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { testS3 } from '@/lib/server/s3Backup';

/** "Test the connection": writes a small file in the bucket's folder and removes it. Owner only, a few a minute. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceLimit(`s3-test:${session.email}`, 10, 10 * 60 * 1000, 'Too many tests. Please wait a few minutes.');
    return json(await testS3());
  } catch (err) {
    return handleRouteError(err, 'admin/backup/s3/test');
  }
}
