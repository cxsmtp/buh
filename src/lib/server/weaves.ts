import { auditOrThrow } from './audit';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { invalidateProducts } from './products';
import { _clearSettingsCache, cleanWeaveName, getSettings, saveRenamedWeave } from './settings';

/**
 * Settings → Catalogue → Weaves. The list itself is catalogue settings (saved like the rest of the
 * card); this is what touches products too: how many use each weave, and "Rename", which changes
 * the weave on every product (archived ones and editor drafts included) and in the list in one
 * transaction, audited before it counts.
 */

/** Products in the shop (not archived) per weave in the list, and any other weave still on one. */
export function weaveUsage(): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(getSettings('catalog').weaves.map((w) => [w, 0]));
  const rows = getDb().prepare("SELECT json_extract(data, '$.weave') AS weave, COUNT(*) AS n FROM products WHERE archived = 0 GROUP BY 1").all() as Array<{ weave: string | null; n: number }>;
  for (const r of rows) if (r.weave) out[r.weave] = (out[r.weave] ?? 0) + r.n;
  return out;
}

export interface RenameResult {
  from: string;
  to: string;
  weaves: string[];
  /** Products whose weave changed (archived included). */
  products: number;
  drafts: number;
  /** The new name was already in the list: the two are one weave now. */
  merged: boolean;
}

/**
 * Rename a weave everywhere. When the new name is already in the list (ignoring capitals), the two
 * are merged: products move to that one and the old name leaves the list.
 */
export function renameWeave(fromIn: unknown, toIn: unknown, actor: string): RenameResult {
  const from = typeof fromIn === 'string' ? fromIn.trim() : '';
  if (!from || !getSettings('catalog').weaves.includes(from)) throw new HttpError(404, 'That weave is not in the list.');
  const typed = cleanWeaveName(toIn, 'New name');
  // Merging into an existing weave keeps that one's spelling.
  const to = getSettings('catalog').weaves.find((w) => w.toLowerCase() === typed.toLowerCase() && w !== from) ?? typed;
  if (to === from) throw new HttpError(400, 'Type a different name.');
  const merged = getSettings('catalog').weaves.includes(to);

  const db = getDb();
  let result: RenameResult;
  try {
    result = inTransaction(() => {
      const now = new Date().toISOString();
      const productIds = (db.prepare("SELECT id FROM products WHERE json_extract(data, '$.weave') = ?").pluck().all(from) as string[]);
      db.prepare("UPDATE products SET data = json_set(data, '$.weave', ?), updated_at = ? WHERE json_extract(data, '$.weave') = ?").run(to, now, from);
      const drafts = db.prepare("UPDATE product_drafts SET data = json_set(data, '$.weave', ?) WHERE json_extract(data, '$.weave') = ?").run(to, from).changes;
      const weaves = saveRenamedWeave(from, to);
      // Written before COMMIT: if the log can't be written, nothing is renamed (503).
      auditOrThrow('catalog.weave_renamed', { by: actor, from, to, merged, products: productIds.length, productIds: productIds.slice(0, 50), drafts });
      return { from, to, weaves, products: productIds.length, drafts, merged };
    });
  } catch (err) {
    // Rolled back: the settings cache must not keep the renamed list.
    _clearSettingsCache();
    throw err;
  }
  invalidateProducts();
  return result;
}
