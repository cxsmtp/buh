/**
 * The announcement bar (reported: "There is a marquee on the top. Let's make it a bit slow and
 * only put very minimal items that is important"): at most three short lines without emoji, the
 * old long default replaced, and a slow drift.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { DEFAULT_MARQUEE, LEGACY_MARQUEE, MARQUEE_MAX_CHARS, marqueeItems, marqueeProblem, stripEmoji } = await import('@/lib/marquee');
const settings = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');

test('by default: three short, calm lines', () => {
  assert.deepEqual(DEFAULT_MARQUEE, ['Free delivery across the UAE in 1–2 days', 'Cash on delivery', 'Handmade in small batches']);
  assert.ok(DEFAULT_MARQUEE.every((l) => l.length <= MARQUEE_MAX_CHARS && stripEmoji(l) === l));
  assert.deepEqual(settings.getSettings('brand').marquee.messages, DEFAULT_MARQUEE);
});

test('the old five long lines with emoji become the new three', () => {
  assert.deepEqual(marqueeItems(LEGACY_MARQUEE), DEFAULT_MARQUEE);
  // A shop that saved the old lines as they were (stored in its database) shows the new ones.
  getDb().prepare('INSERT OR REPLACE INTO settings (key, data, updated_at) VALUES (?, ?, ?)').run('brand', JSON.stringify({ marquee: { enabled: true, speedSeconds: 26, messages: LEGACY_MARQUEE } }), new Date().toISOString());
  settings._clearSettingsCache();
  assert.deepEqual(settings.getSettings('brand').marquee.messages, DEFAULT_MARQUEE);
  const fresh = JSON.parse((getDb().prepare('SELECT data FROM settings WHERE key = ?').get('brand') as { data: string }).data);
  assert.deepEqual(fresh.marquee.messages, LEGACY_MARQUEE, 'stored as it was (nothing rewritten)');
});

test('lines the owner wrote: emoji left out, at most three, long ones shortened at a word', () => {
  assert.deepEqual(marqueeItems(['🌟 New prints this week', '', 'a', 'b', 'c']), ['New prints this week', 'a', 'b']);
  const long = marqueeItems(['Express delivery across Dubai, Abu Dhabi, Sharjah and all seven emirates within two days'])[0];
  assert.ok(long.length <= MARQUEE_MAX_CHARS && long.endsWith('…'), long);
  assert.equal(marqueeProblem(['a', 'b', 'c']), null);
  assert.match(marqueeProblem(['a', 'b', 'c', 'd'])!, /Up to 3/);
  assert.match(marqueeProblem(['x'.repeat(61)])!, /61 characters/);
  assert.equal(marqueeProblem(['🎉'.repeat(30) + 'x'.repeat(60)]), null, 'emoji do not count (they are removed)');
});

test('the bar drifts slowly, pauses on touch, pointer or keyboard, and is still for reduced motion', () => {
  const bar = fs.readFileSync('src/components/common/MarqueeBar.tsx', 'utf8');
  const px = Number(bar.match(/MARQUEE_PX_PER_SECOND = (\d+)/)![1]);
  assert.ok(px >= 25 && px <= 40, `${px} px a second`);
  assert.doesNotMatch(bar, /LIVE|animate-ping|⚡|🌟/);
  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  assert.match(css, /\.marquee:hover \.animate-marquee-runner,\s*\.marquee:focus-within \.animate-marquee-runner/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-marquee-runner \{\s*animation: none;/);
});
