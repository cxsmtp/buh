import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh, empty DATA_DIR for one test file. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-test-'));
  process.env.DATA_DIR = dir;
  // Plenty of every size, so tests are not limited by the shop's one-or-two-pieces stock.
  process.env.SEED_STOCK ??= '50';
  return dir;
}

export function jsonRequest(body: unknown, headers: Record<string, string> = {}, url = 'http://shop.test/api/x') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'shop.test', ...headers },
    body: text,
  });
}

/**
 * Open an Admin Hub section from the bottom bar: directly on wider screens, or through
 * More on a phone (where the bar holds Orders, Inventory, Chats and More).
 */
export async function openAdminSection(page: import('playwright').Page, name: RegExp): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  await nav.waitFor();
  const direct = nav.getByRole('button', { name });
  if ((await direct.count()) && (await direct.first().isVisible())) return direct.first().click();
  await nav.getByRole('button', { name: 'More' }).click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name }).click();
}

/** The database version the current build migrates to (db.ts MIGRATIONS.length). */
export const LATEST_DB_VERSION = 14;

/** Undo migration 14 (accountant accounts, VAT), for tests that rebuild an older database. */
export const UNDO_MIGRATION_14 = 'DROP TABLE vat_credit_notes; DROP TABLE vat_invoices; DROP TABLE order_vat; DROP TABLE staff_accounts; ALTER TABLE expenses DROP COLUMN vat_fils; ALTER TABLE expenses DROP COLUMN supplier_trn;';
