/**
 * Settings → Look: the shop's looks (presets), each in light and dark, chosen by the owner, with
 * the device deciding light or dark unless the owner fixes one. The tokens of every look are
 * readable (WCAG AA) in both variants, festival accents included; the light Ivory & Gold is
 * exactly the palette from before looks existed; every change is kept with its time, who made it
 * and a label, and switching back restores it exactly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PALETTE, type Token } from '@/lib/design/tokens';
import {
  DEFAULT_LOOK_PRESET,
  FESTIVE_SOFT_DARK_PCT,
  LOOK_MODES,
  LOOK_PRESET_IDS,
  LOOK_PRESETS,
  contrast,
  festiveAccentForDark,
  festiveGlowForDark,
  lookCss,
  mix,
  type LookVariant,
} from '@/lib/design/themes';
import { FESTIVE_ACCENTS } from '@/lib/festivals/catalog';
import { tempDataDir } from './helpers.mjs';

/** Every pairing the pages use, at the ratio it needs (4.5 text, 3 large text and focus rings). */
function problems(v: LookVariant, where: string): string[] {
  const c = v.colors;
  const out: string[] = [];
  const need = (fg: string, bg: string, min: number, what: string) => {
    const r = contrast(fg, bg);
    if (r < min) out.push(`${where}: ${what} ${r.toFixed(2)}:1 (needs ${min})`);
  };
  for (const bg of ['ivory', 'surface', 'sand'] as const) {
    // Body text, muted text, links (gold-deep), badges' text and the status colours.
    for (const fg of ['ink', 'ink-2', 'ink-soft', 'ink-muted', 'gold-deep', 'rose-deep', 'success', 'warning', 'danger'] as const) need(c[fg], c[bg], 4.5, `${fg} on ${bg}`);
    // The keyboard's focus ring (gold-deep), and a field's placeholder (ink-muted at 85%: a hint,
    // not content; 4.2:1 in the shop's look from before looks, which stays as it was).
    need(c['gold-deep'], c[bg], 3, `focus ring on ${bg}`);
    need(mix(c[bg], c['ink-muted'], 0.85), c[bg], 3.5, `placeholder on ${bg}`);
  }
  // Text typed in a field (ink on the field's surface) and its hairline border (visible, decorative).
  need(c.ink, c.surface, 7, 'field text');
  if (contrast(c['line-strong'], c.surface) < 1.4) out.push(`${where}: field border invisible`);
  if (contrast(c.line, c.surface) < 1.1) out.push(`${where}: hairline invisible`);
  for (const [fg, bg] of [['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft'], ['rose-deep', 'rose-soft'], ['sand', 'ink']] as const) {
    need(c[fg], c[bg], 4.5, `${fg} on ${bg}`);
  }
  // Inside an ink panel (and gold badges), with the dark variants' own golds and ink there.
  const inkGold = v.onInk?.gold ?? c.gold;
  const inkGoldLight = v.onInk?.['gold-light'] ?? c['gold-light'];
  const goldInk = v.onGold ?? c.ink;
  need(inkGold, c.ink, 4.5, 'gold on ink');
  need(inkGoldLight, c.ink, 4.5, 'gold-light on ink');
  need(goldInk, c.gold, 4.5, 'ink on gold badge');
  // Buttons: paper lettering on ink, success, danger, antique gold and WhatsApp.
  for (const bg of ['ink', 'ink-2', 'success', 'danger', 'gold-deep', 'whatsapp'] as const) need(c.paper, c[bg], 4.5, `paper on ${bg}`);
  return out;
}

test('every look, light and dark, is readable: text, muted text, links, buttons, badges, fields, focus rings (WCAG AA)', () => {
  const bad: string[] = [];
  for (const id of LOOK_PRESET_IDS) {
    const p = LOOK_PRESETS[id];
    bad.push(...problems(p.light, `${id} light`), ...problems(p.dark, `${id} dark`));
  }
  assert.deepEqual(bad, []);
});

test('festival accents stay readable in every look, light and dark', () => {
  const bad: string[] = [];
  for (const [name, a] of Object.entries(FESTIVE_ACCENTS)) {
    const dark = festiveAccentForDark(a.accent);
    for (const id of LOOK_PRESET_IDS) {
      const l = LOOK_PRESETS[id].light.colors;
      const d = LOOK_PRESETS[id].dark.colors;
      // Light: the accent on the page and on its own soft band (the catalogue's values, as before).
      for (const bg of [l.ivory, l.surface, a.soft]) if (contrast(a.accent, bg) < 4.5) bad.push(`${name} on ${id} light ${bg}: ${contrast(a.accent, bg).toFixed(2)}`);
      // Dark: the lifted accent on the page, the cards, and its band (a tint over the card colour).
      const band = mix(d.surface, dark, FESTIVE_SOFT_DARK_PCT / 100);
      for (const bg of [d.ivory, d.surface, d.sand, band]) if (contrast(dark, bg) < 4.5) bad.push(`${name} on ${id} dark ${bg}: ${contrast(dark, bg).toFixed(2)}`);
      // The motif's fine line is decorative but visible.
      if (contrast(festiveGlowForDark(a.glow), d.ivory) < 3) bad.push(`${name} glow on ${id} dark`);
    }
  }
  assert.deepEqual(bad, []);
});

test('Ivory & Gold in light is exactly the palette from before looks existed', () => {
  // The values the shop shipped with (BUH-02.09), written out so a change to PALETTE shows here.
  const before: Record<string, string> = {
    ivory: '#faf6ef', surface: '#fffdf9', sand: '#f2ebdf', 'sand-deep': '#e8decd', line: '#e5dac9', 'line-strong': '#cbbba3',
    ink: '#2b2127', 'ink-2': '#43353d', 'ink-soft': '#5a4c53', 'ink-muted': '#6a5c62', gold: '#c2a36b', 'gold-light': '#e6d5b0',
    'gold-deep': '#82612c', rose: '#c49a98', 'rose-soft': '#f4e8e5', 'rose-deep': '#8a5659', success: '#3d6a4e', 'success-soft': '#eaf1ea',
    'success-line': '#c8dacb', warning: '#85601c', 'warning-soft': '#f7eedb', 'warning-line': '#e8d3a6', danger: '#9a3e39',
    'danger-soft': '#f7e6e2', 'danger-line': '#e7c3bc', whatsapp: '#1f7a47', paper: '#ffffff', scrim: '#2b2127',
  };
  assert.deepEqual(LOOK_PRESETS['ivory-gold'].light.colors, before);
  assert.deepEqual({ ...PALETTE }, before);
  assert.equal(LOOK_PRESETS['ivory-gold'].light.onInk, undefined);
  // globals.css (what the page has before /look.css arrives) carries the same values.
  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  for (const [t, hex] of Object.entries(before)) assert.match(css, new RegExp(`--color-${t}:\\s*${hex};`), t);
});

/** The bright looks with a Dubai feel (opt-in in Settings → Look). */
const BRIGHT = ['jumeirah-azure', 'civic-gold', 'digital-skyline', 'palm-fresh'] as const;

test('the bright looks: light and airy by day, each with its own dark version; the default stays Ivory & Gold', () => {
  assert.equal(DEFAULT_LOOK_PRESET, 'ivory-gold');
  const lum = (hex: string) => contrast(hex, '#000000');
  for (const id of BRIGHT) {
    assert.ok((LOOK_PRESET_IDS as readonly string[]).includes(id), id);
    const p = LOOK_PRESETS[id];
    // Bright: the page and the cards are near white (brighter than the warm looks' linen), yet never
    // pure white, so the cards still read as cards and no surface glares.
    for (const t of ['ivory', 'surface'] as const) {
      assert.ok(lum(p.light.colors[t]) >= 19.5, `${id} light ${t} is bright`);
      assert.notEqual(p.light.colors[t], '#ffffff');
    }
    // A real dark version: dark surfaces with light lettering.
    assert.ok(lum(p.dark.colors.ivory) < 1.4, `${id} dark ivory`);
    assert.ok(contrast(p.dark.colors.ink, p.dark.colors.ivory) >= 12, `${id} dark ink`);
    // Inspired by the region's design, not presented as anyone's: no official names or words.
    for (const text of [p.name, p.description]) assert.doesNotMatch(text, /official|government|ministry|emirates?\b|federal|\bUAE\b|Dubai/i, `${id}: ${text}`);
  }
  assert.equal(LOOK_PRESETS['civic-gold'].light.colors.gold, '#b68a35');
});

test('every look has every token in both variants, as #rrggbb', () => {
  const tokens = Object.keys(PALETTE).sort();
  for (const id of LOOK_PRESET_IDS) {
    for (const v of ['light', 'dark'] as const) {
      const colors = LOOK_PRESETS[id][v].colors;
      assert.deepEqual(Object.keys(colors).sort(), tokens, `${id} ${v}`);
      for (const t of tokens) assert.match(colors[t as Token], /^#[0-9a-f]{6}$/, `${id} ${v} ${t}`);
    }
    assert.equal(LOOK_PRESETS[id].id, id);
  }
  assert.ok(LOOK_PRESET_IDS.length >= 3);
});

test('the look stylesheet: light, dark, or the device decides', () => {
  const sys = lookCss('noir-champagne', 'system');
  assert.match(sys, /^\/\* Beautiful UAE Home: Noir & Champagne, Match the device \*\//);
  assert.match(sys, /:root\{color-scheme:light;--color-ivory:#f7f5f1;/);
  assert.match(sys, /@media \(prefers-color-scheme: dark\)\{html:root\{color-scheme:dark;--color-ivory:#121110;/);
  assert.match(sys, /\[data-festive\]\{--festive-now:var\(--festive-dark\)/);
  const light = lookCss('noir-champagne', 'light');
  assert.doesNotMatch(light, /prefers-color-scheme|color-scheme:dark/);
  const dark = lookCss('noir-champagne', 'dark');
  assert.doesNotMatch(dark, /prefers-color-scheme|color-scheme:light/);
  assert.match(dark, /:root\{color-scheme:dark;/);
  assert.match(dark, /html:root \.bg-ink,html:root \.bg-ink-2\{--color-gold:/);
  for (const id of LOOK_PRESET_IDS) for (const m of LOOK_MODES) assert.doesNotMatch(lookCss(id, m), /<|undefined|NaN/);
});

test('looks: the default for an existing shop, history with timestamps, switch back, validation', async () => {
  tempDataDir();
  const { getDb } = await import('@/lib/server/db');
  const { currentLook, earlierLooks, saveLook, switchBackLook, LOOK_BEFORE_THEMES_LABEL } = await import('@/lib/server/look');
  const { getSettings, restoreSettingsVersion, _clearSettingsCache } = await import('@/lib/server/settings');
  getDb();
  _clearSettingsCache();

  // An existing shop after the update: Ivory & Gold, matching the device; the look from before kept.
  const start = currentLook();
  assert.equal(start.preset, 'ivory-gold');
  assert.equal(start.mode, 'system');
  assert.match(start.changedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  const first = earlierLooks();
  assert.equal(first.length, 1);
  assert.equal(first[0].label, LOOK_BEFORE_THEMES_LABEL);
  assert.equal(first[0].preset, 'ivory-gold');
  assert.equal(first[0].mode, 'light');
  assert.match(first[0].changedAt, /Z$/);

  // The same look again is no change.
  await saveLook({ preset: 'ivory-gold', mode: 'system' }, 'owner@shop.ae');
  assert.equal(earlierLooks().length, 1);
  assert.equal(currentLook().changedBy, '');

  // A change: kept with when and who, and the one it replaced goes to the list.
  const t0 = Date.now();
  await saveLook({ preset: 'noir-champagne', mode: 'dark' }, 'owner@shop.ae');
  const now = currentLook();
  assert.equal(now.preset, 'noir-champagne');
  assert.equal(now.mode, 'dark');
  assert.equal(now.changedBy, 'owner@shop.ae');
  assert.equal(now.label, 'Noir & Champagne · Always dark');
  assert.ok(Date.parse(now.changedAt) >= t0 - 1000);
  const list = earlierLooks();
  assert.equal(list.length, 2);
  assert.equal(list[0].preset, 'ivory-gold');
  assert.equal(list[0].mode, 'system');
  assert.equal(list[1].label, LOOK_BEFORE_THEMES_LABEL);

  // Switch back to the look from before themes: exactly that preset and mode.
  await switchBackLook(list[1].id, 'owner@shop.ae');
  const back = currentLook();
  assert.equal(back.preset, 'ivory-gold');
  assert.equal(back.mode, 'light');
  assert.equal(back.label, `Switched back to: ${LOOK_BEFORE_THEMES_LABEL}`);
  assert.equal(back.changedBy, 'owner@shop.ae');
  // The look from before themes is never dropped, however many changes follow.
  for (let i = 0; i < 35; i++) await saveLook({ preset: i % 2 ? 'sand-rose' : 'pearl-emerald', mode: 'system' }, 'owner@shop.ae');
  assert.ok(earlierLooks().some((e) => e.label === LOOK_BEFORE_THEMES_LABEL));
  assert.ok(earlierLooks().length <= 31);

  // Settings → System → History restores a look too, as a new change by whoever restored it.
  assert.equal(currentLook().preset, 'pearl-emerald');
  const anyOld = earlierLooks().find((e) => e.preset === 'sand-rose')!;
  await restoreSettingsVersion(anyOld.id, 'second@shop.ae');
  assert.equal(currentLook().preset, 'sand-rose');
  assert.equal(currentLook().changedBy, 'second@shop.ae');

  // The bright looks are on the server's allow-list, kept in the history and switched back like any other.
  for (const preset of BRIGHT) {
    await saveLook({ preset, mode: 'light' }, 'owner@shop.ae');
    assert.equal(currentLook().preset, preset);
    assert.equal(currentLook().label, `${LOOK_PRESETS[preset].name} · Always light`);
  }
  const azure = earlierLooks().find((e) => e.preset === 'jumeirah-azure')!;
  assert.equal(azure.label, 'Jumeirah Azure · Always light');
  await switchBackLook(azure.id, 'owner@shop.ae');
  assert.deepEqual([currentLook().preset, currentLook().mode], ['jumeirah-azure', 'light']);
  assert.equal(currentLook().label, 'Switched back to: Jumeirah Azure · Always light');

  // Only known looks and modes; nothing else is stored.
  await assert.rejects(saveLook({ preset: 'neon', mode: 'system' }, 'a@b.c'), /Unknown look/);
  await assert.rejects(saveLook({ preset: 'ivory-gold', mode: 'sometimes' }, 'a@b.c'), /Mode must be/);
  await assert.rejects(switchBackLook(999999, 'a@b.c'), /no longer kept/);
  const stored = getSettings('look') as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), ['changedAt', 'changedBy', 'label', 'mode', 'preset']);
});

test('migration 13 only adds rows: an existing shop (database version 12) keeps everything and gains its starting look', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-v12-'));
  const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(dir)}; ${code}`], { encoding: 'utf8' });
  assert.equal(run(`const m = await import('@/lib/server/db'); (m.getDb ?? m.default.getDb)();`).status, 0);
  // Back to version 12, as a shop running BUH-02.11 has it, with a branding setting saved.
  const db = new Database(path.join(dir, 'shop.db'));
  db.exec("DELETE FROM settings_history WHERE key = 'look'; DELETE FROM settings WHERE key = 'look'");
  db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('brand', '{\"storeName\":\"Kept\"}', '2026-01-01T00:00:00.000Z')").run();
  db.pragma('user_version = 12');
  db.close();
  const up = run(`const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(JSON.stringify({ v: db.pragma('user_version', { simple: true }), settings: db.prepare("SELECT key, data FROM settings ORDER BY key").all(), history: db.prepare("SELECT key, data, saved_at FROM settings_history").all() }));`);
  assert.equal(up.status, 0, up.stderr);
  const out = JSON.parse(up.stdout.trim().split('\n').pop()!);
  assert.equal(out.v, 13);
  assert.deepEqual(out.settings.find((s: { key: string }) => s.key === 'brand'), { key: 'brand', data: '{"storeName":"Kept"}' });
  const look = JSON.parse(out.settings.find((s: { key: string }) => s.key === 'look').data);
  assert.deepEqual([look.preset, look.mode], ['ivory-gold', 'system']);
  assert.equal(out.history.length, 1);
  const before = JSON.parse(out.history[0].data);
  assert.deepEqual([before.preset, before.mode, before.label, before.pinned], ['ivory-gold', 'light', 'Ivory & Gold — the look before themes', true]);
  assert.equal(before.changedAt, out.history[0].saved_at);
  assert.equal(before.changedAt, look.changedAt, 'both timestamped at migration time');
});
