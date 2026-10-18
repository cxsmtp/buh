/**
 * Reported: "Track your order has a glitch and the box is overlapped". The title bar sat over the
 * order-number field (no space between them), hiding its top edge. At 375 and 1280 px, before and
 * after a search, the first field starts clearly below the title bar and nothing covers it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

let pw: typeof import('playwright') | null = null;
try {
  pw = await import('playwright');
} catch {
  pw = null;
}
const skip = !hasBuild || !pw;
let server: RunningServer;
before(async () => {
  if (!skip) server = await startServer();
});
after(() => server?.stop());

for (const width of [375, 1280]) {
  test(`Track Order at ${width}px: the title bar never covers the fields`, { skip }, async () => {
    const browser = await pw!.chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width, height: width < 768 ? 812 : 800 } })).newPage();
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      await page.locator('main h3').first().waitFor();
      await (width < 768 ? page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: /Orders/ }) : page.getByRole('button', { name: /Track Order/ })).click();
      const dialog = page.getByRole('dialog', { name: 'Track your order' });
      await dialog.waitFor();
      const check = async (when: string) => {
        const r = await page.evaluate(() => {
          const title = document.getElementById('track-title')!.closest('.sticky')!.getBoundingClientRect();
          const input = document.querySelector('[aria-label="Order number"]')!;
          const box = input.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 2);
          return { gap: box.top - title.bottom, onTop: hit === input };
        });
        assert.ok(r.gap >= 8, `${when}: ${r.gap}px between the title bar and the first field`);
        assert.ok(r.onTop, `${when}: the first field's top edge is not covered`);
      };
      await check('opened');
      await dialog.getByLabel('Order number').fill('BUH-000000-AAAAAA');
      await dialog.getByLabel('Mobile number on the order').fill('0501234567');
      await dialog.getByRole('button', { name: 'Track', exact: true }).click();
      await page.waitForTimeout(800);
      await check('after a search');
    } finally {
      await browser.close();
    }
  });
}
