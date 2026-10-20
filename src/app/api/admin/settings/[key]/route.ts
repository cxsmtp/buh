import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { auditPaymentOptions, paymentOptions, paymentsModeWarning } from '@/lib/server/payments';
import { adminView, getSettings, undoVersionId, type SettingsKey } from '@/lib/server/settings';
import { saveGuarded } from '@/lib/server/settingsGuard';
import { WRITING_FIELDS } from '@/lib/aiPrompt';
import type { AiPromptSettings } from '@/lib/aiPrompt';
import type { AiPicturesSettings } from '@/lib/staging';

/**
 * The AI prompts' own audit entries: which parts changed and their lengths, never their words
 * (Settings → AI writing → Prompt, Settings → AI pictures).
 */
function auditPrompts(key: SettingsKey, before: unknown, by: string) {
  if (key === 'aiPrompt') {
    const was = before as AiPromptSettings;
    const now = getSettings('aiPrompt');
    const fields = WRITING_FIELDS.filter((f) => (was.fields?.[f.id] ?? '') !== (now.fields?.[f.id] ?? '')).map((f) => f.id);
    const instructions = was.instructions !== now.instructions;
    if (!instructions && !fields.length) return;
    audit('settings.ai_prompt_changed', {
      by,
      instructionsChanged: instructions,
      instructionsLength: now.instructions.length,
      instructionsDefault: !now.instructions,
      fieldsChanged: fields,
      fieldLengths: Object.fromEntries(WRITING_FIELDS.map((f) => [f.id, (now.fields?.[f.id] ?? '').length])),
    });
  }
  if (key === 'aiPictures') {
    const was = before as AiPicturesSettings;
    const now = getSettings('aiPictures');
    if (JSON.stringify(was) === JSON.stringify(now)) return;
    audit('settings.ai_pictures_changed', { by, scenes: now.scenes.length, sceneIds: now.scenes.map((s) => s.id), defaultSet: now.defaultSet, lookLength: now.look.length, lookDefault: !now.look, lookChanged: was.look !== now.look, references: now.references.length, useReferences: now.useReferences });
    // The style photos (which pictures, in which order; their names only).
    const names = (l: string[] | undefined) => (l ?? []).map((u) => u.replace(/^\/api\/images\//, ''));
    if (JSON.stringify(names(was.references)) !== JSON.stringify(names(now.references)) || was.useReferences !== now.useReferences) {
      audit('settings.ai_style_photos_changed', { by, count: now.references.length, photos: names(now.references), added: names(now.references).filter((n) => !names(was.references).includes(n)), removed: names(was.references).filter((n) => !names(now.references).includes(n)), useReferences: now.useReferences });
    }
  }
}

const KEYS: SettingsKey[] = ['brand', 'bank', 'courier', 'sms', 'catalog', 'store', 'theme', 'email', 'assistant', 'delivery', 'payments', 'phoneCheck', 'ai', 'aiPrompt', 'aiPictures'];

export async function PUT(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { key } = await params;
    if (!KEYS.includes(key as SettingsKey)) throw new HttpError(404, 'Unknown settings.');
    // Branding may carry a logo image (stored as a file).
    const body = await readJsonBody(req, key === 'brand' ? 4 * 1024 * 1024 : 64 * 1024);
    const keyBefore = key === 'payments' ? getSettings('payments').stripeSecretKey : '';
    const optionsBefore = key === 'payments' ? paymentOptions() : null;
    const promptBefore = key === 'aiPrompt' || key === 'aiPictures' ? structuredClone(getSettings(key)) : null;
    // Validated, and tried first where possible: a change that fails keeps the working settings.
    const result = await saveGuarded(key as SettingsKey, body.settings, undefined, { auto: body.auto === true });
    // Keys of another Stripe mode while card orders are open: said, not blocked.
    const warning = key === 'payments' ? paymentsModeWarning(keyBefore, getSettings('payments').stripeSecretKey) : null;
    // Field names only: never the values (they may be keys).
    audit('settings.updated', { by: session.email, key, fields: Object.keys((body.settings as object) || {}), auto: body.auto === true, verified: result.verified });
    // The card fee and the bank-transfer choice change what customers pay and see: from and to.
    if (optionsBefore) auditPaymentOptions(optionsBefore, session.email);
    if (promptBefore) auditPrompts(key as SettingsKey, promptBefore, session.email);
    return json({ success: true, ...result, undoId: undoVersionId(key as SettingsKey), ...adminView(key as SettingsKey), ...(warning ? { warning } : {}) });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/update');
  }
}
