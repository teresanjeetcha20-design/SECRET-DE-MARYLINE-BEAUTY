/**
 * Extrait les prix du catalogue d'origine depuis public/index.html (tableau SMB_PRODUCTS)
 * et écrit netlify/lib/catalog.mjs, lu par le serveur pour recalculer les montants.
 * Lancé à chaque déploiement (netlify.toml) : la liste ne peut pas diverger du site.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const blocks = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
const src = blocks.find((b) => b.includes('const SMB_PRODUCTS = ['));
if (!src) throw new Error('Catalogue introuvable dans public/index.html (marqueur « const SMB_PRODUCTS = [ »).');

// Évaluation isolée du script du catalogue (contenu du dépôt, aucune donnée externe)
const ctx = vm.createContext({ window: {}, document: { addEventListener() {} }, console });
vm.runInContext(src + '\n;this.__P = SMB_PRODUCTS;', ctx);
const catalog = ctx.__P.map((p) => ({
  id: p.slug,
  name: p.name,
  formats: (p.formats || []).map((f) => ({ size: String(f.size || ''), price: f.price == null ? null : Number(f.price) })),
}));
if (catalog.length < 1) throw new Error('Catalogue vide');

writeFileSync(join(root, 'netlify/lib/catalog.mjs'),
  `// FICHIER GÉNÉRÉ par scripts/extract-catalog.mjs — ne pas modifier à la main.\n// Source : public/index.html (${catalog.length} produits)\nexport default ${JSON.stringify(catalog, null, 2)};\n`);
console.log(`catalog.mjs : ${catalog.length} produits extraits.`);
