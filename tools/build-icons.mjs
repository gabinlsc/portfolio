// Génère assets/_glsc/icons.js : uniquement les icônes Lucide utilisées dans les pages,
// plus un petit remplaçant de lucide.createIcons(). Relancer après avoir ajouté une icône :
//   npm run build:icons
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lucide = require('lucide');

const PAGES = ['index.html', 'cv/index.html', 'old/index.html', 'projets/index.html', 'games/index.html', 'games/profil/index.html', 'games/nouveautes/index.html', 'status/index.html', 'errors/404.html'];

const toPascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

const names = new Set();
for (const page of PAGES) {
  const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
  for (const m of html.matchAll(/data-lucide="([a-z0-9-]+)"/g)) names.add(m[1]);
}

const icons = {};
for (const name of [...names].sort()) {
  const node = lucide.icons[toPascal(name)] || lucide[toPascal(name)];
  if (!node) throw new Error(`Icône Lucide inconnue : ${name}`);
  icons[name] = node[2]; // enfants du <svg>
}

const js = `/*! Icônes Lucide v0.460.0 (ISC, https://lucide.dev) — sous-ensemble généré par tools/build-icons.mjs */
(function () {
  'use strict';
  var ICONS = ${JSON.stringify(icons)};
  var NS = 'http://www.w3.org/2000/svg';
  var BASE = { xmlns: NS, width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };

  function build(name, el) {
    var svg = document.createElementNS(NS, 'svg');
    Object.keys(BASE).forEach(function (k) { svg.setAttribute(k, BASE[k]); });
    svg.setAttribute('class', ['lucide', 'lucide-' + name, el.getAttribute('class') || ''].join(' ').trim());
    ICONS[name].forEach(function (child) {
      var node = document.createElementNS(NS, child[0]);
      Object.keys(child[1]).forEach(function (k) { node.setAttribute(k, child[1][k]); });
      svg.appendChild(node);
    });
    return svg;
  }

  function render() {
    var list = document.querySelectorAll('[data-lucide]');
    Array.prototype.forEach.call(list, function (el) {
      var name = el.getAttribute('data-lucide');
      if (ICONS[name]) el.parentNode.replaceChild(build(name, el), el);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
`;

writeFileSync(new URL('../assets/_glsc/icons.js', import.meta.url), js);
console.log(`icons.js : ${names.size} icônes`);

// ---------------------------------------------------------------- admin.glsc.fr : module ES icon(nom)
const ADMIN = new URL('../admin/public/assets/', import.meta.url);
const adminFiles = ['app.js', 'lib.js', ...readdirSync(new URL('modules/', ADMIN)).map((f) => `modules/${f}`)];
const adminNames = new Set();
for (const file of adminFiles) {
  const src = readFileSync(new URL(file, ADMIN), 'utf8');
  for (const m of src.matchAll(/(?:icon|iconBtn)\('([a-z0-9-]+)'|iconName: '([a-z0-9-]+)'/g)) adminNames.add(m[1] || m[2]);
  for (const m of src.matchAll(/icônes du menu : ([a-z0-9 -]+)/g)) m[1].trim().split(/\s+/).forEach((n) => adminNames.add(n));
}
const adminIcons = {};
for (const name of [...adminNames].sort()) {
  const node = lucide.icons[toPascal(name)] || lucide[toPascal(name)];
  if (!node) throw new Error(`Icône Lucide inconnue (admin) : ${name}`);
  adminIcons[name] = node[2];
}
writeFileSync(new URL('icons.js', ADMIN), `/*! Icônes Lucide v0.460.0 (ISC, https://lucide.dev) — sous-ensemble généré par tools/build-icons.mjs */
const ICONS = ${JSON.stringify(adminIcons)};
const NS = 'http://www.w3.org/2000/svg';

/** icon('nom') → <svg> décoratif (aria-hidden). */
export function icon(name, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  const attrs = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: \`lucide lucide-\${name} \${cls}\`.trim() };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  if (!ICONS[name]) console.warn('icône absente du sous-ensemble :', name);
  for (const [tag, a] of ICONS[name] || []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}
`);
console.log(`admin : ${adminNames.size} icônes`);
