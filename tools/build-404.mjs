// Recalcule la CSP de errors/404.html : le style et le script en ligne y sont autorisés par leur empreinte SHA-256.
// La page est autonome (aucun fichier à côté) pour pouvoir servir de 404 à tous les sites, jeux et admin compris.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../errors/404.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const hash = (tag) => {
  const m = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`<${tag}> introuvable dans errors/404.html`);
  return `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`;
};
const csp = [
  "default-src 'none'",
  `style-src 'self' ${hash('style')}`,
  `script-src ${hash('script')}`,
  "img-src data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const out = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/, `$1${csp}$2`);
if (out === html) console.log('errors/404.html : CSP déjà à jour');
else { writeFileSync(file, out); console.log('errors/404.html : CSP mise à jour'); }
