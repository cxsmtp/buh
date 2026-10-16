/**
 * The installable app's manifest, from Settings → Branding: the name under the icon, upright on
 * phones but free to turn on tablets, icons (maskable too) that change address when the logo
 * changes, and the Bag and Track Order shortcuts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest, displayName, iconVersion, isPhoneAgent, shortName } from '@/lib/server/appManifest';
import { INITIAL_BRAND_SETTINGS } from '@/data/initialData';

const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

test('names: a shouting store name reads as a name; the label under the icon fits a phone', () => {
  assert.equal(displayName('BEAUTIFUL UAE HOME'), 'Beautiful UAE Home');
  assert.equal(displayName('Linen & Co'), 'Linen & Co');
  assert.equal(displayName(''), 'Beautiful UAE Home');
  assert.equal(shortName('Beautiful UAE Home'), 'UAE Home');
  assert.equal(shortName('Linen & Co'), 'Linen & Co');
  assert.ok(shortName('Supercalifragilistic Linens').length <= 12);
});

test('phones get portrait, tablets and computers any orientation', () => {
  assert.ok(isPhoneAgent(ANDROID_PHONE) && isPhoneAgent(IPHONE));
  assert.ok(!isPhoneAgent(ANDROID_TABLET) && !isPhoneAgent(IPAD));
  assert.equal(buildManifest(INITIAL_BRAND_SETTINGS, ANDROID_PHONE).orientation, 'portrait-primary');
  assert.equal(buildManifest(INITIAL_BRAND_SETTINGS, ANDROID_TABLET).orientation, 'any');
});

test('the manifest: standalone, the brand colours, 192/512 icons in both kinds, shortcuts to Bag and Track Order', () => {
  const m = buildManifest(INITIAL_BRAND_SETTINGS, ANDROID_PHONE);
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.name, 'Beautiful UAE Home');
  // The palette's ink and ivory (src/lib/design/tokens.ts).
  assert.equal(m.theme_color, '#2b2127');
  assert.equal(m.background_color, '#faf6ef');
  const icons = m.icons!.map((i) => `${i.purpose} ${i.sizes}`);
  assert.deepEqual(icons.sort(), ['any 192x192', 'any 512x512', 'maskable 192x192', 'maskable 512x512']);
  assert.deepEqual(m.shortcuts!.map((s) => s.url), ['/?open=bag', '/?open=track']);
  // A new logo is a new icon address, so phones fetch it.
  const v1 = iconVersion(INITIAL_BRAND_SETTINGS);
  const v2 = iconVersion({ ...INITIAL_BRAND_SETTINGS, logoType: 'image', logoImageUrl: '/api/images/' + 'b'.repeat(64) + '.png' });
  assert.notEqual(v1, v2);
  assert.ok(m.icons!.every((i) => i.src.endsWith(`?v=${v1}`)));
});
