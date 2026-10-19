import { BILL_CSP } from '@/lib/csp';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getExpense, readBill, removeBill } from '@/lib/server/expenses';

/**
 * A bill's photo or PDF, for the signed-in hub only, never cached, its type fixed by its kind
 * (nosniff). A photo is shown in the browser (inline) under BILL_CSP (sandboxed: nothing in it can
 * run; next.config.ts sends the same policy for this path). A PDF is downloaded instead
 * (attachment): browsers refuse to show a PDF under a sandbox policy, and a PDF can carry script.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; bill: string }> }) {
  try {
    await requireAdmin(req);
    const { id, bill } = await params;
    const file = readBill(id, bill);
    if (!file) throw new HttpError(404, 'Bill not found.');
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': `${file.ext === 'pdf' ? 'attachment' : 'inline'}; filename="${id}-${bill.slice(0, 6)}.${file.ext}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': BILL_CSP,
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/bills/get');
  }
}

/** Take a bill off its expense: { reason }. The file is kept (and stays in backups). Audited before it counts. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; bill: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id, bill } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['reason']);
    if (!getExpense(id) || !/^[a-f0-9]{24}$/.test(bill)) throw new HttpError(404, 'Bill not found.');
    const removed = removeBill(id, bill, body.reason, session.email);
    return json({ bill: removed, expense: getExpense(id) });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/bills/remove');
  }
}
