import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { createExpense, EXPENSE_METHODS, listCategories, listExpenses } from '@/lib/server/expenses';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Money → Expenses: the expenses dated from..to (newest first; ?removed=1 adds removed ones), the categories and payment methods. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const q = new URL(req.url).searchParams;
    const from = q.get('from') ?? undefined;
    const to = q.get('to') ?? undefined;
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new HttpError(400, 'Dates must be YYYY-MM-DD.');
    return json({ expenses: listExpenses({ from, to, includeRemoved: q.get('removed') === '1', limit: 2000 }), categories: listCategories(), methods: EXPENSE_METHODS });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses');
  }
}

/**
 * A new expense: { key, date, amount ("125.50"), categoryId, method, payee?, note? }. The key (one
 * per "Save") makes a retry return the first expense instead of a second. Audited before it counts.
 * Bills are attached next, one by one (./[id]/bills).
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 8 * 1024);
    allowFields(body, ['key', 'date', 'amount', 'categoryId', 'method', 'payee', 'note']);
    const { key, ...fields } = body;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(400, 'key is required (one per save).');
    const { expense, created } = createExpense(fields, session.email, key);
    return json({ expense, created }, created ? 201 : 200);
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/create');
  }
}
