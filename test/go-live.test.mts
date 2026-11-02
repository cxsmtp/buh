/**
 * Go live (src/lib/server/goLive.ts; asked by the owner: "everything so far was a test; flush the
 * orders, financials to zero"): the test orders removed for good with their history, VAT, card and
 * transfer records, the pieces back in stock, a backup made first and the audit written before
 * anything goes. Refused while an order carries real money (a live card payment) or a real courier
 * booking. Products, settings and the audit log stay; chats only when asked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const orders = await import('@/lib/server/orders');
const { listProducts, getProduct } = await import('@/lib/server/products');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const { startChat } = await import('@/lib/server/chat');
const { goLive, goLivePreview, GO_LIVE_PHRASE } = await import('@/lib/server/goLive');

await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place() {
  _clearAllRateLimits();
  const p = listProducts()[0];
  const phone = `+9715070${String(++n).padStart(5, '0')}`;
  return orders.placeOrder(
    {
      idempotencyKey: `go-live-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Test Customer', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    },
    { ip: `10.1.${n}.1` }
  ).order;
}
const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

test('Go live: the test orders go (history, screenshots), their pieces back in stock, a backup first, audited; products and settings stay', async () => {
  const product = listProducts()[0];
  const size = product.profiles[0].id;
  const stockBefore = getProduct(product.id)!.stockBySize[size];
  const a = place();
  const b = place();
  const c = place();
  orders.updateOrderByAdmin(c.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal(getProduct(product.id)!.stockBySize[size], stockBefore - 2, 'two pieces held, the cancelled one back');
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'receipts', `${a.id}-1.png`), 'x');
  startChat({ message: 'Is the king set in stock?', ip: '10.9.9.9' });

  const preview = goLivePreview();
  assert.deepEqual({ orders: preview.orders, pieces: preview.pieces, screenshots: preview.screenshots, chats: preview.chats, blockers: preview.blockers }, { orders: 3, pieces: 2, screenshots: 1, chats: 1, blockers: [] });
  assert.equal(preview.wentLive, null);
  assert.ok(count('order_events') > 0);

  const r = await goLive({ chats: false }, 'owner@shop.test');
  assert.deepEqual({ orders: r.orders, pieces: r.pieces, screenshots: r.screenshots, chats: r.chats }, { orders: 3, pieces: 2, screenshots: 1, chats: 0 });
  // Gone: the orders and everything that hangs on them.
  for (const t of ['orders', 'order_events', 'order_vat', 'card_refunds', 'vat_invoices', 'vat_credit_notes', 'stripe_events']) assert.equal(count(t), 0, t);
  assert.equal(orders.getOrder(a.id), undefined);
  assert.equal(orders.getOrder(b.id), undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipts')), []);
  // The pieces the test orders held are back; the product and the settings stay.
  assert.equal(getProduct(product.id)!.stockBySize[size], stockBefore);
  assert.ok(listProducts().length > 0);
  assert.equal(count('chat_threads'), 1, 'chats stay unless asked');
  // A backup first (the orders can be restored from it), and the audit says so.
  assert.match(r.backup, /\.(tar|tgz|tar\.gz|enc|bak)/);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f === r.backup), r.backup);
  const went = auditLines().find((l) => l.action === 'shop.went_live');
  assert.ok(went);
  assert.equal(went.details.orders, 3);
  assert.equal(went.details.backup, r.backup);
  assert.ok(auditLines().some((l) => l.action === 'stock.moved' || /stock/.test(l.action)), 'the returned pieces are on the stock history');
  assert.equal(goLivePreview().wentLive?.backup, r.backup);
  // Again, with the chats: they go too; a shop with no orders is fine.
  const again = await goLive({ chats: true }, 'owner@shop.test');
  assert.equal(again.orders, 0);
  assert.equal(again.chats, 1);
  assert.equal(count('chat_threads'), 0);
  assert.equal(GO_LIVE_PHRASE, 'GO LIVE');
});

test('Go live refuses while an order carries real money or a real shipment, and removes nothing', async () => {
  const real = place();
  const card = place();
  const db = getDb();
  const data = JSON.parse((db.prepare('SELECT data FROM orders WHERE id = ?').get(real.id) as { data: string }).data);
  data.courier = { ...data.courier, provider: 'jeebly', awbNumber: 'JB777', carrierEnv: 'live', bookingState: 'booked', simulated: false };
  db.prepare('UPDATE orders SET data = ? WHERE id = ?').run(JSON.stringify(data), real.id);
  db.prepare("UPDATE orders SET card_state = 'paid', card_livemode = 1 WHERE id = ?").run(card.id);
  const preview = goLivePreview();
  assert.equal(preview.blockers.length, 2);
  assert.match(preview.blockers.join(' '), new RegExp(`${real.id} was booked with the courier for real \\(AWB JB777\\)`));
  assert.match(preview.blockers.join(' '), new RegExp(`${card.id} has a real card payment`));
  const backupsBefore = fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).length : 0;
  await assert.rejects(goLive({ chats: true }, 'owner@shop.test'), (e: { status?: number; details?: { code?: string } }) => e.status === 409 && e.details?.code === 'go_live_real_orders');
  assert.equal(count('orders'), 2, 'nothing removed');
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, backupsBefore, 'no backup made for a refused go-live');
  // A test booking (sandbox) or a test card payment is fine.
  data.courier = { ...data.courier, carrierEnv: 'sandbox', simulated: true, testKind: 'sandbox' };
  db.prepare('UPDATE orders SET data = ? WHERE id = ?').run(JSON.stringify(data), real.id);
  db.prepare("UPDATE orders SET card_livemode = 0 WHERE id = ?").run(card.id);
  assert.deepEqual(goLivePreview().blockers, []);
});
