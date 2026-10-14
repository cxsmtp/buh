import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { listCustomers } from '@/lib/server/orders';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ customers: listCustomers() });
  } catch (err) {
    return handleRouteError(err, 'admin/customers');
  }
}
