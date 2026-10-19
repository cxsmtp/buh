import crypto from 'node:crypto';
import type { LookSettings } from '@/types';
import { LOOK_PRESETS, isLookMode, isLookPreset, lookCss, type LookMode, type LookPresetId } from '@/lib/design/themes';
import { getDb } from './db';
import { HttpError } from './http';
import { getSettings, restoreSettingsVersion, updateSettings } from './settings';

/**
 * Settings → Look: which look the shop wears (src/lib/design/themes.ts) and whether the device
 * picks light or dark. Kept as the 'look' settings, so every change is a version in the settings
 * history (with its time, who made it and a label) and switching back is a restore.
 */

export const LOOK_BEFORE_THEMES_LABEL = 'Ivory & Gold — the look before themes';

export interface LookEntry {
  /** The settings-history version (for Switch back). */
  id: number;
  preset: LookPresetId;
  mode: LookMode;
  label: string;
  changedAt: string;
  changedBy: string;
  /** The look from before looks existed: never pruned. */
  pinned: boolean;
}

export function currentLook(): LookSettings {
  const look = getSettings('look');
  if (look.changedAt) return look;
  // Never saved (cannot happen after migration 13): the time the settings row was written.
  const row = getDb().prepare("SELECT updated_at FROM settings WHERE key = 'look'").get() as { updated_at: string } | undefined;
  return { ...look, changedAt: row?.updated_at ?? '' };
}

/** Earlier looks, newest first (the versions the current one replaced). */
export function earlierLooks(limit = 40): LookEntry[] {
  const rows = getDb().prepare("SELECT id, data, saved_at FROM settings_history WHERE key = 'look' ORDER BY id DESC LIMIT ?").all(Math.min(100, limit)) as Array<{ id: number; data: string; saved_at: string }>;
  return rows.flatMap((r) => {
    let d: Partial<LookSettings> & { pinned?: boolean };
    try {
      d = JSON.parse(r.data);
    } catch {
      return [];
    }
    if (!isLookPreset(d.preset) || !isLookMode(d.mode)) return [];
    return [{ id: r.id, preset: d.preset, mode: d.mode, label: String(d.label || LOOK_PRESETS[d.preset].name), changedAt: String(d.changedAt || r.saved_at), changedBy: String(d.changedBy || ''), pinned: d.pinned === true }];
  });
}

/** Choose a look (validated against the allow-lists in the settings validator). */
export async function saveLook(input: { preset: unknown; mode: unknown }, by: string): Promise<LookSettings> {
  // The same look again changes nothing (no new entry in the list).
  const now = currentLook();
  if (input.preset === now.preset && input.mode === now.mode) return now;
  await updateSettings('look', { preset: input.preset, mode: input.mode, label: null, changedBy: by }, { keepHistory: true });
  return currentLook();
}

/** Put an earlier look back, exactly: its preset and mode, as a new change by `by`. */
export async function switchBackLook(id: number, by: string): Promise<LookSettings> {
  const row = getDb().prepare('SELECT key FROM settings_history WHERE id = ?').get(id) as { key: string } | undefined;
  if (!row || row.key !== 'look') throw new HttpError(404, 'That look is no longer kept.');
  await restoreSettingsVersion(id, by);
  return currentLook();
}

let cssCache: { key: string; css: string; etag: string } | null = null;

/** /look.css for the current look, with an ETag (recomputed only when the look changes). */
export function currentLookCss(): { css: string; etag: string } {
  const { preset, mode } = getSettings('look');
  const key = `${preset}|${mode}`;
  if (cssCache?.key !== key) {
    const css = lookCss(preset, mode);
    cssCache = { key, css, etag: `"${crypto.createHash('sha256').update(css).digest('base64url').slice(0, 16)}"` };
  }
  return { css: cssCache.css, etag: cssCache.etag };
}
