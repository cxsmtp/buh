import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { attachBill, BILL_LIMITS, getExpense } from '@/lib/server/expenses';

/**
 * Attach a bill to an expense: { file: data URL (a photo or a PDF), name? }. Checked by its bytes,
 * 10 MB at most, photos without their metadata; refused (507) when the disk or the bills folder is
 * full. Audited before it counts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    // Base64 is a third bigger than the file, plus the JSON around it.
    const body = await readJsonBody(req, Math.ceil(BILL_LIMITS.fileBytes * 4 / 3) + 4096);
    allowFields(body, ['file', 'name']);
    if (!getExpense(id)) throw new HttpError(404, 'Expense not found.');
    const bill = attachBill(id, body.file, body.name, session.email);
    return json({ bill, expense: getExpense(id) }, 201);
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/bills/add');
  }
}
