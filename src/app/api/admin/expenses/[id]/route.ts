import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { expenseVersions, getExpense, removeExpense, updateExpense } from '@/lib/server/expenses';

/** One expense, with every earlier version and every bill (removed ones too). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const expense = getExpense(id);
    if (!expense) throw new HttpError(404, 'Expense not found.');
    return json({ expense, versions: expenseVersions(id) });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/get');
  }
}

/**
 * Change an expense: { version (the one shown), date?, amount?, categoryId?, method?, payee?, note? }.
 * The earlier version is kept; a version changed meanwhile is 409. Audited (before → after) before it counts.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 8 * 1024);
    allowFields(body, ['version', 'date', 'amount', 'categoryId', 'method', 'payee', 'note']);
    if (!getExpense(id)) throw new HttpError(404, 'Expense not found.');
    return json({ expense: updateExpense(id, body, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/update');
  }
}

/** "Remove": { reason }. Kept in the books (and the backups), out of the totals. Never deleted. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['reason']);
    if (!getExpense(id)) throw new HttpError(404, 'Expense not found.');
    return json({ expense: removeExpense(id, body.reason, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/remove');
  }
}
