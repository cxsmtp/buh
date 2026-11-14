import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { adminView, behindProxy, phoneCheckNoticeDue, settingsUpdatedAt, type SettingsKey } from '@/lib/server/settings';

const VERSIONED: SettingsKey[] = ['brand', 'bank', 'courier', 'sms', 'catalog', 'store', 'theme', 'email', 'assistant', 'delivery', 'payments', 'phoneCheck', 'ai', 'aiPrompt', 'aiPictures', 'backups'];

/** All settings for the admin hub; secrets come back blank, with a "saved" flag. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // ?versions=1: only when each group was last saved (a settings form sends its group's back with a save).
    if (new URL(req.url).searchParams.get('versions') === '1') {
      return json({ versions: Object.fromEntries(VERSIONED.map((k) => [k, settingsUpdatedAt(k)])) });
    }
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
      ai: adminView('ai'),
      aiPrompt: adminView('aiPrompt'),
      aiPictures: adminView('aiPictures'),
      // Settings → Phone check's warning (no TRUST_PROXY: stricter limits) and the hub's one-time notice.
      phoneCheckInfo: { behindProxy: behindProxy(), whatsappNotice: phoneCheckNoticeDue() },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/settings');
  }
}
