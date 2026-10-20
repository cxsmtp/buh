// The product page's line under the price: a product without a thread count showed "· 0 TC · Sateen".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specLine } from '@/lib/productType';

test('the spec line leaves out what is not filled in', () => {
  assert.equal(specLine({ productType: 'bedding', material: '', threadCount: 0, weave: 'Sateen' }), 'Sateen');
  assert.equal(specLine({ productType: 'bedding', material: 'Cotton', threadCount: 300, weave: 'Percale' }), 'Cotton · 300 TC · Percale');
  assert.equal(specLine({ productType: 'simple', material: 'Linen', threadCount: 0, weave: '' }), 'Linen');
  assert.equal(specLine({ productType: 'bedding', material: '', threadCount: 0, weave: '' }), '');
});
