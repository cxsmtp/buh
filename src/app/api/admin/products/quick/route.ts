import { autoStatus, dismissJob, listJobs, quickAdd } from '@/lib/server/autoAdd';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { getProduct } from '@/lib/server/products';

/**
 * Quick add (src/lib/server/autoAdd.ts): whether new products are written and pictured by AI, and
 * the latest ones with where each is (writing, making picture 2 of 3, waiting for Google, in the
 * shop, needs you). Owner only.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const jobs = listJobs().map((j) => {
      const p = getProduct(j.productId);
      return { id: j.id, productId: j.productId, title: p?.title ?? '', cover: p?.featuredImage ?? '', state: j.state, made: j.made.filter(Boolean).length, planned: j.plan.length, note: j.note, until: j.until ?? null, active: p?.active !== false, updatedAt: j.updatedAt };
    });
    return json({ ...autoStatus(), jobs });
  } catch (err) {
    return handleRouteError(err, 'admin/products/quick/status');
  }
}

/** Add one product from the basics; it is saved at once and finished in the background. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 8 * 1024);
    const { product, job, replayed } = quickAdd(body, session.email);
    return json({ success: true, product, jobId: job?.id ?? null, replayed });
  } catch (err) {
    return handleRouteError(err, 'admin/products/quick');
  }
}

/** { id }: take a finished one off the list (the product stays). */
export async function DELETE(req: Request) {
  try {
    await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    dismissJob(body.id);
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/products/quick/dismiss');
  }
}
