import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { addCategory, listCategories } from '@/lib/server/expenses';

/** The expense categories (the owner's list). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ categories: listCategories() });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/categories');
  }
}

/** Add a category: { name }. A name already on the list returns that one. Audited before it counts. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['name']);
    const category = addCategory(body.name, session.email);
    return json({ category, categories: listCategories() });
  } catch (err) {
    return handleRouteError(err, 'admin/expenses/categories/add');
  }
}
