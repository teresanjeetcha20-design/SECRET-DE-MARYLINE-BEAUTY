import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone } from '../netlify/lib/phone.mjs';

test('normalisation Cameroun', () => {
  for (const v of ['695123456', '6 95 12 34 56', '+237 695 12 34 56', '00237695123456', '237695123456', '0695123456']) {
    assert.equal(normalizePhone(v, 'CMR'), '237695123456', v);
  }
});
test('Gabon : format international exigé', () => {
  assert.equal(normalizePhone('+241 77 12 34 56', 'GAB'), '24177123456');
  assert.equal(normalizePhone('77123456', 'GAB'), null);
});
test('numéros invalides', () => {
  for (const v of ['', 'abc', '12', '+0237695', '6951234']) assert.equal(normalizePhone(v, 'CMR'), null, v);
  assert.equal(normalizePhone('+241771234567', 'CMR'), null);   // indicatif ≠ pays
});
test('masquage pour les journaux', () => {
  assert.equal(maskPhone('237695123456'), '2376*****456');
});
