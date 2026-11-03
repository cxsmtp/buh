/**
 * Reported: "We need to improve the label. I don't want fake/dummy details. The label is not real."
 * The label had decorative bars instead of a barcode, an invented shipper and hub, fixed contents
 * and "AED 515.00"-style amounts. Now: a real Code 128 barcode (checked against the reference
 * patterns here), the owner's own pickup details, the order's real contents, and a TEST watermark
 * on a test booking.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { code128Bars, code128Values, code128Widths, PATTERNS, QUIET, STOP } from '@/lib/code128';
import { aed2 } from '@/lib/courierMode';

test('the Code 128 table: 107 distinct symbols, 11 modules each (Stop 13), 3 bars and 3 spaces', () => {
  assert.equal(PATTERNS.length, 107);
  assert.equal(new Set(PATTERNS).size, 107);
  PATTERNS.forEach((p, i) => {
    assert.equal([...p].reduce((a, c) => a + Number(c), 0), i === STOP ? 13 : 11, `symbol ${i}`);
    assert.equal(p.length, i === STOP ? 7 : 6);
  });
});

test('Code 128B of "AB" matches the reference patterns: Start B, A, B, checksum 102, Stop', () => {
  // Reference (ISO/IEC 15417): Start B 104 = 211214, "A" (33) = 111323, "B" (34) = 131123,
  // checksum (104 + 1×33 + 2×34) mod 103 = 102 = 411131, Stop = 2331112.
  assert.deepEqual(code128Values('AB'), [104, 33, 34, 102, 106]);
  assert.equal(code128Widths('AB'), '211214' + '111323' + '131123' + '411131' + '2331112');
});

test('Code 128B checksum of a typical AWB, and of "Wikipedia" (the textbook example, check value 88)', () => {
  assert.deepEqual(code128Values('Wikipedia').slice(-2), [88, 106]);
  const v = code128Values('JB-1234');
  const sum = 104 + [...'JB-1234'].reduce((s, ch, i) => s + (ch.charCodeAt(0) - 32) * (i + 1), 0);
  assert.equal(v.at(-2), sum % 103);
});

test('the bars start with the quiet zone and end with it; bad input is refused', () => {
  const { bars, total } = code128Bars('BUH-261018-123456');
  assert.equal(bars[0][0], QUIET, 'first bar after 10 quiet modules');
  const last = bars.at(-1)!;
  assert.equal(total - (last[0] + last[1]), QUIET, 'and 10 after the last bar');
  assert.equal(total, (17 + 3) * 11 + 2 + 2 * QUIET);
  assert.throws(() => code128Values(''));
  assert.throws(() => code128Values('é'));
  assert.throws(() => code128Values('tab\t'));
});

test('regression: the label shows nothing invented', () => {
  const src = fs.readFileSync('src/components/admin/ShippingLabelModal.tsx', 'utf8');
  for (const invented of [
    'BEAUTIFUL UAE HOME LLC',
    'WH 14',
    'Al Quoz',
    '829 4110',
    '-CENTRAL',
    'Luxury Bedding Set',
    'Official Carrier Compliant',
    '}.00',
    'Simulated High-Density',
    'JEEBLY LOGISTICS UAE',
    'Next-Day Scheduled Delivery',
  ]) {
    assert.ok(!src.includes(invented), invented);
  }
  assert.match(src, /Barcode128 value=\{c\.awbNumber\}/, 'a real barcode of the AWB');
  assert.match(src, /Barcode128 value=\{order\.id\}/, 'and of the order number');
  assert.match(src, /TEST BOOKING – NOT A REAL SHIPMENT – DO NOT SEND/);
  assert.match(src, /Add your pickup address in Couriers/);
  assert.match(src, /Print Jeebly label \(PDF\)/, "Jeebly's own label is the main action for a Jeebly booking");
  assert.match(src, /carrier-label/);
  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  assert.match(css, /#printable-shipping-label \{\s*width: 4in;\s*height: 6in;/);
  // On A5 (the default paper), the label is enlarged to fill the page and centred across it.
  assert.match(css, /#shipping-label-print\[data-paper='a5'\] #printable-shipping-label \{\s*transform: scale\(1\.37\);/);
  assert.match(src, /@page \{ size: A5 portrait; margin: 0; \}/);
  assert.match(src, /paper === '4x6' \? '@media print \{ @page \{ size: 4in 6in; margin: 0; \} \}'/);
});

test('amounts on the label have two decimals', () => {
  assert.equal(aed2(515), '515.00');
  assert.equal(aed2(1249.5), '1,249.50');
  assert.equal(aed2(0.1 + 0.2), '0.30');
});

test('reported: the label printed "Beautiful UAE Home" as the sender; it shows the pickup name entered in Couriers (the legal name), the shop name only when none is set', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Label } = await import('@/components/admin/ShippingLabelModal');
  const order = {
    id: 'BUH-261103-ABCDEF', createdAt: new Date().toISOString(), status: 'confirmed', paymentMethod: 'cod', paymentStatus: 'cod_pending', total: 275, subtotal: 275, deliveryFee: 0, codFee: 0, discount: 0,
    customer: { fullName: 'Hessa Test', phone: '+971501234567', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: 'p', title: 'King set', image: '', profileId: 'king', profileName: 'King', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', unitPrice: 275, quantity: 1, totalPrice: 275 }],
    courier: { provider: 'jeebly', serviceType: 'Scheduled', awbNumber: 'JB1', trackingUrl: '', status: '', pickupDate: '', weightKg: 1, pieces: 1, labelGenerated: true, codAmountCollected: 275 },
  } as unknown as import('@/types').Order;
  const pickup = { pickupLocationName: 'Beautiful Home Trading L.L.C', pickupPhone: '+971 50 111 2222', pickupAddress: 'Street 5', pickupArea: 'Al Barsha 1', pickupEmirate: 'Dubai' };
  const html = renderToStaticMarkup(React.createElement(Label, { order, shopName: 'Beautiful UAE Home', pickup }));
  assert.match(html, /data-testid="label-sender">Beautiful Home Trading L\.L\.C</);
  assert.doesNotMatch(html, /Beautiful UAE Home/, 'the shop name is not printed when a pickup name is set');
  const fallback = renderToStaticMarkup(React.createElement(Label, { order, shopName: 'Beautiful UAE Home', pickup: { ...pickup, pickupLocationName: '' } }));
  assert.match(fallback, /data-testid="label-sender">Beautiful UAE Home</);
});
