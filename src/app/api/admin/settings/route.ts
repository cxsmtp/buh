import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { adminView } from '@/lib/server/settings';

/** All settings for the admin hub; secrets come back blank, with a "saved" flag. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({
      brand: adminView('brand'),
      bank: adminView('bank'),
      courier: adminView('courier'),
      sms: adminView('sms'),
      catalog: adminView('catalog'),
      store: adminView('store'),
      theme: adminView('theme'),
      email: adminView('email'),
      assistant: adminView('assistant'),
      delivery: adminView('delivery'),
      payments: adminView('payments'),
      phoneCheck: adminView('phoneCheck'),
    });
  } catch (err) {
    return handleRouteError(err, 'admin/settings');
  }
}
