import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { adminView, behindProxy, phoneCheckNoticeDue, settingsUpdatedAt, type SettingsKey } from '@/lib/server/settings';

const VERSIONED: SettingsKey[] = ['brand', 'bank', 'courier', 'sms', 'catalog', 'store', 'theme', 'email', 'assistant', 'delivery', 'payments', 'phoneCheck', 'ai', 'aiPrompt', 'aiPictures', 'backups'];

/** A group as the hub edits it, with when it was last saved (a form sends that back with its save). */
const view = <K extends SettingsKey>(key: K) => ({ ...adminView(key), updatedAt: settingsUpdatedAt(key) });

/** All settings for the admin hub; secrets come back blank, with a "saved" flag. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    // ?versions=1: only when each group was last saved (a settings form sends its group's back with a save).
    if (new URL(req.url).searchParams.get('versions') === '1') {
      return json({ versions: Object.fromEntries(VERSIONED.map((k) => [k, settingsUpdatedAt(k)])) });
    }
    return json({
      brand: view('brand'),
      bank: view('bank'),
      courier: view('courier'),
      sms: view('sms'),
      catalog: view('catalog'),
      store: view('store'),
      theme: view('theme'),
      email: view('email'),
      assistant: view('assistant'),
      delivery: view('delivery'),
      payments: view('payments'),
      phoneCheck: view('phoneCheck'),
      ai: view('ai'),
      aiPrompt: view('aiPrompt'),
      aiPictures: view('aiPictures'),
      // Settings → Phone check's warning (no TRUST_PROXY: stricter limits) and the hub's one-time notice.
      phoneCheckInfo: { behindProxy: behindProxy(), whatsappNotice: phoneCheckNoticeDue() },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/settings');
  }
}
