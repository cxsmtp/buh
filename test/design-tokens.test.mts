/**
 * One palette (reported: "there are too many color palettes"). The colours are design tokens,
 * defined once in src/lib/design/tokens.ts and as CSS variables in globals.css (`@theme`); these
 * tests keep the two in step and keep every page on them: no hard-coded colours, no Tailwind
 * colour scales (stone, emerald, amber, red…), and the installed app's colours from the tokens.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP_BACKGROUND_COLOR, PALETTE, THEME_COLOR } from '@/lib/design/tokens';
import { contrastRatio } from '@/lib/festivals/catalog';

const css = fs.readFileSync('src/app/globals.css', 'utf8');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const sources = files('src').filter((f) => /\.(tsx?|css)$/.test(f));

test('the CSS tokens and the TypeScript palette are the same colours', () => {
  for (const [name, hex] of Object.entries(PALETTE)) {
    const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i'));
    assert.ok(m, `--color-${name} is declared in globals.css`);
    assert.equal(m![1].toLowerCase(), hex, `--color-${name}`);
  }
  // Tailwind's own colour scales are switched off, so only the tokens exist.
  assert.match(css, /--color-\*:\s*initial;/);
  const declared = [...css.matchAll(/--color-([a-z0-9-]+):\s*#/gi)].map((m) => m[1]);
  for (const name of declared) assert.ok(name in PALETTE || ['white', 'black'].includes(name), `${name} is a palette token`);
});

test('no page uses a colour outside the palette', () => {
  const scale = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border(?:-[trblxy])?|divide|ring|outline|from|via|to|fill|stroke|placeholder|decoration|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
  const arbitrary = /-\[#[0-9a-f]{3,8}\]/i;
  const bad: string[] = [];
  for (const f of sources) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (scale.test(line) || arbitrary.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('hard-coded hex colours live only in the palette, the festival accents and product data', () => {
  // Product colour swatches and photo backgrounds are content (the colours of real sheets).
  const allowed = new Set([
    'src/lib/design/tokens.ts',
    'src/app/globals.css',
    'src/lib/festivals/catalog.ts',
    'src/data/initialData.ts',
    'src/lib/catalogFilter.ts',
    'src/lib/aiImageTransform.ts',
    'src/lib/server/settings.ts',
  ]);
  const bad: string[] = [];
  for (const f of sources.map((s) => s.split(path.sep).join('/'))) {
    if (allowed.has(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const m of line.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
        if (/^#(fff|ffffff|000|000000)$/i.test(m[0])) continue;
        bad.push(`${f}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('text tokens are readable on every light surface (WCAG AA)', () => {
  const surfaces = ['ivory', 'surface', 'sand'] as const;
  for (const bg of surfaces) {
    for (const fg of ['ink', 'ink-2', 'ink-soft', 'ink-muted', 'gold-deep', 'rose-deep', 'success', 'warning', 'danger'] as const) {
      assert.ok(contrastRatio(PALETTE[fg], PALETTE[bg]) >= 4.5, `${fg} on ${bg}: ${contrastRatio(PALETTE[fg], PALETTE[bg]).toFixed(2)}`);
    }
  }
  for (const [fg, bg] of [['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft'], ['rose-deep', 'rose-soft'], ['ink', 'gold'], ['gold', 'ink'], ['gold-light', 'ink'], ['sand', 'ink']] as const) {
    assert.ok(contrastRatio(PALETTE[fg], PALETTE[bg]) >= 4.5, `${fg} on ${bg}: ${contrastRatio(PALETTE[fg], PALETTE[bg]).toFixed(2)}`);
  }
  for (const bg of ['ink', 'ink-2', 'success', 'danger', 'gold-deep', 'whatsapp'] as const) {
    assert.ok(contrastRatio('#ffffff', PALETTE[bg]) >= 4.5, `white on ${bg}`);
  }
});

test('the installed app and the status bar take the palette', () => {
  assert.equal(THEME_COLOR, PALETTE.ink);
  assert.equal(APP_BACKGROUND_COLOR, PALETTE.ivory);
  const layout = fs.readFileSync('src/app/layout.tsx', 'utf8');
  assert.match(layout, /themeColor: THEME_COLOR/);
  // Self-hosted fonts: the serif for headings and the sans for everything else.
  assert.match(layout, /cormorant-garamond-latin-500-normal\.woff2/);
  assert.match(layout, /inter-latin-wght-normal\.woff2/);
  for (const f of ['cormorant-garamond-latin-500-normal.woff2', 'cormorant-garamond-latin-600-normal.woff2', 'inter-latin-wght-normal.woff2', 'OFL-Cormorant-Garamond.txt', 'OFL-Inter.txt']) {
    assert.ok(fs.existsSync(path.join('src/app/fonts', f)), f);
  }
});
