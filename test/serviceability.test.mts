import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJeeblyServiceability, findClosestUAELocation } from '@/lib/jeeblyServiceability';

test('every emirate is serviceable, with COD', () => {
  for (const emirate of ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain']) {
    const r = checkJeeblyServiceability({ emirate, area: 'Test' });
    assert.equal(r.serviceable, true, emirate);
    assert.equal(r.codAllowed, true, emirate);
    assert.equal(r.matchedEmirate, emirate);
  }
});

test('a GPS pin outside the UAE is refused', () => {
  assert.equal(checkJeeblyServiceability({ emirate: 'Dubai', lat: 51.5, lng: -0.12 }).serviceable, false); // London
  assert.equal(checkJeeblyServiceability({ emirate: 'Dubai', lat: 25.08, lng: 55.14 }).serviceable, true); // Marina
});

test('closest known area to a pin', () => {
  assert.equal(findClosestUAELocation(25.0775, 55.1395).name, 'Dubai Marina');
  assert.equal(findClosestUAELocation(24.4965, 54.6060).name, 'Yas Island');
});
