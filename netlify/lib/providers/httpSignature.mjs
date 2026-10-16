/**
 * Vérification des signatures HTTP (RFC 9421) utilisées par PawaPay pour signer ses callbacks.
 * En-têtes attendus : Signature, Signature-Input, Signature-Date, Content-Digest, Content-Type.
 */
import { createHash, createPublicKey, verify as cryptoVerify, constants } from 'node:crypto';

const MAX_SKEW_SECONDS = 300;

function header(headers, name) {
  const k = Object.keys(headers || {}).find(h => h.toLowerCase() === name.toLowerCase());
  const v = k ? headers[k] : undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Content-Digest: sha-512=:BASE64:  (ou sha-256) — vérifie l'intégrité du corps brut. */
export function verifyContentDigest(headerValue, rawBody) {
  if (!headerValue) return false;
  const entries = String(headerValue).split(',').map(s => s.trim());
  for (const e of entries) {
    const m = e.match(/^(sha-512|sha-256)=:([A-Za-z0-9+/=]+):$/i);
    if (!m) continue;
    const algo = m[1].toLowerCase() === 'sha-512' ? 'sha512' : 'sha256';
    const expected = createHash(algo).update(rawBody, 'utf8').digest('base64');
    if (expected === m[2]) return true;
  }
  return false;
}

/** Signature-Input: sig-pp=("@method" "@path" ...);alg="...";keyid="...";created=...;expires=... */
export function parseSignatureInput(value) {
  const m = String(value || '').match(/^\s*([A-Za-z0-9_-]+)=(\((.*?)\)(.*))$/);
  if (!m) return null;
  const label = m[1];
  const paramsRaw = m[2];
  const components = [...m[3].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  const params = {};
  for (const p of m[4].split(';').map(s => s.trim()).filter(Boolean)) {
    const [k, v] = p.split('=');
    params[k] = v && v.startsWith('"') ? v.slice(1, -1) : Number(v);
  }
  return { label, components, params, paramsRaw };
}

export function parseSignature(value, label) {
  const re = new RegExp(`${label}=:([A-Za-z0-9+/=]+):`);
  const m = String(value || '').match(re);
  return m ? Buffer.from(m[1], 'base64') : null;
}

export function buildSignatureBase({ method, url, headers }, parsed) {
  const u = new URL(url);
  const lines = parsed.components.map(c => {
    let v;
    if (c === '@method') v = String(method).toUpperCase();
    else if (c === '@authority') v = (header(headers, 'host') || u.host).toLowerCase();
    else if (c === '@path') v = u.pathname;
    else if (c === '@target-uri') v = u.toString();
    else if (c === '@query') v = u.search || '?';
    else {
      v = header(headers, c);
      if (v === undefined) throw new Error(`composant absent : ${c}`);
      v = String(v).trim();
    }
    return `"${c}": ${v}`;
  });
  lines.push(`"@signature-params": ${parsed.paramsRaw}`);
  return lines.join('\n');
}

function verifyWithAlg(alg, keyPem, data, sig) {
  const key = createPublicKey(keyPem);
  switch (alg) {
    case 'ecdsa-p256-sha256':
    case 'ecdsa-p384-sha384': {
      const hash = alg.endsWith('256') ? 'sha256' : 'sha384';
      // PawaPay envoie des signatures ECDSA encodées en DER ; on accepte aussi le format brut r||s.
      return cryptoVerify(hash, data, { key, dsaEncoding: 'der' }, sig)
        || (sig.length === (hash === 'sha256' ? 64 : 96) && cryptoVerify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig));
    }
    case 'rsa-pss-sha512':
      return cryptoVerify('sha512', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, sig);
    case 'rsa-v1_5-sha256':
      return cryptoVerify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
    default:
      return false;
  }
}

/**
 * @param req {method, url, headers, rawBody}
 * @param getPublicKey async (keyid) => PEM | null
 */
export async function verifyHttpSignature(req, getPublicKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const input = parseSignatureInput(header(req.headers, 'signature-input'));
  if (!input) return { valid: false, reason: 'SIGNATURE_INPUT_MISSING' };
  const sig = parseSignature(header(req.headers, 'signature'), input.label);
  if (!sig) return { valid: false, reason: 'SIGNATURE_MISSING' };
  if (!input.components.includes('content-digest')) return { valid: false, reason: 'DIGEST_NOT_SIGNED' };
  if (!verifyContentDigest(header(req.headers, 'content-digest'), req.rawBody)) return { valid: false, reason: 'DIGEST_MISMATCH' };
  const { created, expires, keyid, alg } = input.params;
  if (typeof created === 'number' && created > nowSeconds + MAX_SKEW_SECONDS) return { valid: false, reason: 'SIGNATURE_FROM_FUTURE' };
  if (typeof expires === 'number' && expires < nowSeconds - MAX_SKEW_SECONDS) return { valid: false, reason: 'SIGNATURE_EXPIRED' };
  const pem = await getPublicKey(keyid);
  if (!pem) return { valid: false, reason: 'UNKNOWN_KEY' };
  let base;
  try { base = buildSignatureBase(req, input); } catch (e) { return { valid: false, reason: 'BAD_COMPONENTS' }; }
  let ok = false;
  try { ok = verifyWithAlg(alg, pem, Buffer.from(base, 'utf8'), sig); } catch (e) { ok = false; }
  return ok ? { valid: true } : { valid: false, reason: 'BAD_SIGNATURE' };
}
