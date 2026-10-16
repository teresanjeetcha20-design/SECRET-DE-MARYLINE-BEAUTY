import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verifyHttpSignature } from '../netlify/lib/providers/httpSignature.mjs';
import { signedCallback, TEST_PUB, TEST_KEY_ID } from './helpers.mjs';

const keys = async id => (id === TEST_KEY_ID ? TEST_PUB.export({ type: 'spki', format: 'pem' }) : null);
const body = { depositId: '11111111-2222-4333-8444-555555555555', status: 'COMPLETED', amount: '100', currency: 'XAF' };

test('callback correctement signé : accepté', async () => {
  assert.deepEqual(await verifyHttpSignature(signedCallback(body), keys), { valid: true });
});
test('corps modifié : refusé', async () => {
  const r = await verifyHttpSignature(signedCallback(body, { tamper: s => s.replace('100', '1') }), keys);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'DIGEST_MISMATCH');
});
test('signé avec une autre clé : refusé', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const r = await verifyHttpSignature(signedCallback(body, { privateKey: other }), keys);
  assert.equal(r.reason, 'BAD_SIGNATURE');
});
test('chemin différent (rejeu vers une autre URL) : refusé', async () => {
  const req = signedCallback(body);
  req.url = 'https://shop.test/autre-chemin';
  assert.equal((await verifyHttpSignature(req, keys)).valid, false);
});
test('sans signature : refusé', async () => {
  const req = signedCallback(body);
  delete req.headers.signature; delete req.headers['signature-input'];
  assert.equal((await verifyHttpSignature(req, keys)).valid, false);
});
