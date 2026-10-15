// Mini-outils de dev, 100 % dans le navigateur (rien n'est envoyé au serveur).
import { h, clear, sectionHead, card, btn, copy, segmented, toast } from '../lib.js';
import { qrSvg, downloadSvg } from './short.js';

const TOOLS = [
  ['password', 'Mot de passe'], ['base64', 'Base64'], ['jwt', 'JWT'], ['regex', 'Regex'], ['qr', 'QR code'],
  ['time', 'Dates'], ['hash', 'Hash'], ['uuid', 'UUID'], ['json', 'JSON'], ['url', 'URL'],
];
let current = 'password';

export function render(root) {
  const panel = h('div', {});
  const tabs = h('div', {});
  const show = () => {
    clear(tabs, segmented(TOOLS, current, (v) => { current = v; show(); }, 'Outil'));
    clear(panel, BUILD[current]());
  };
  root.append(sectionHead('Mini-outils', 'Tout se calcule dans ton navigateur.'), h('div', { class: 'tools-tabs' }, tabs), panel);
  show();
}

const area = (props = {}) => h('textarea', { class: 'input mono', rows: 5, spellcheck: 'false', ...props });
const out = () => h('pre', { class: 'output mono' });
const copyBtn = (el) => btn('Copier', () => copy(el.value ?? el.textContent), { iconName: 'copy' });
const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

const BUILD = {
  password() {
    const len = h('input', { type: 'range', min: 8, max: 64, value: 20, 'aria-label': 'Longueur' });
    const lenOut = h('b', {}, '20');
    const opts = { lower: true, upper: true, digits: true, symbols: true, words: false };
    const result = h('input', { class: 'input mono big-input', readonly: true, 'aria-label': 'Mot de passe généré' });
    const WORDS = 'abeille arbre banane bateau biscuit bougie cactus canard carotte castor cerise chapeau chaton citron clavier coffre comete crabe dragon etoile falaise fusee girafe glacier guitare hamac hibou igloo jardin kiwi lanterne licorne lune mangue marmotte meduse miel montagne nuage olive orage panda papillon pirate planete poulpe radis renard robot sapin soleil tigre tomate tortue tulipe vague volcan yaourt zebre'.split(' ');
    const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
    const gen = () => {
      lenOut.textContent = len.value;
      if (opts.words) {
        result.value = Array.from({ length: Math.max(4, Math.round(len.value / 5)) }, () => WORDS[rnd(WORDS.length)]).join('-') + '-' + rnd(100);
        return;
      }
      const sets = [opts.lower && 'abcdefghijkmnopqrstuvwxyz', opts.upper && 'ABCDEFGHJKLMNPQRSTUVWXYZ', opts.digits && '23456789', opts.symbols && '!@#$%&*?-_=+'].filter(Boolean);
      if (!sets.length) { result.value = ''; return; }
      const all = sets.join('');
      const chars = sets.map((s) => s[rnd(s.length)]);
      while (chars.length < len.value) chars.push(all[rnd(all.length)]);
      for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
      result.value = chars.join('');
    };
    len.addEventListener('input', gen);
    const check = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts[k], onchange: (e) => { opts[k] = e.target.checked; gen(); } }), h('span', {}, label));
    gen();
    return card('Générateur de mot de passe', h('div', { class: 'stack-sm' }, result,
      h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Longueur ', len, ' ', lenOut)),
      h('div', { class: 'row' }, check('lower', 'minuscules'), check('upper', 'MAJUSCULES'), check('digits', 'chiffres'), check('symbols', 'symboles'), check('words', 'phrase de mots')),
      h('div', { class: 'row' }, btn('Nouveau', gen, { kind: 'primary', iconName: 'refresh-cw' }), copyBtn(result))));
  },

  base64() {
    const input = area({ placeholder: 'Texte ou base64' });
    const result = area({ readonly: true });
    const run = (mode) => {
      try {
        result.value = mode === 'enc'
          ? btoa(String.fromCharCode(...new TextEncoder().encode(input.value)))
          : new TextDecoder().decode(Uint8Array.from(atob(input.value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')), (c) => c.charCodeAt(0)));
      } catch { result.value = '⚠ Base64 invalide'; }
    };
    return card('Base64', h('div', { class: 'stack-sm' }, input,
      h('div', { class: 'row' }, btn('Encoder', () => run('enc'), { kind: 'primary' }), btn('Décoder', () => run('dec')), copyBtn(result)), result));
  },

  jwt() {
    const input = area({ placeholder: 'eyJhbGciOi…', rows: 4 });
    const result = out();
    input.addEventListener('input', () => {
      const parts = input.value.trim().split('.');
      if (parts.length < 2) { result.textContent = ''; return; }
      const decode = (p) => JSON.stringify(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))), null, 2);
      try {
        const payload = JSON.parse(decode(parts[1]));
        const dates = ['iat', 'nbf', 'exp'].filter((k) => payload[k]).map((k) => `${k} : ${new Date(payload[k] * 1000).toLocaleString('fr-FR')}${k === 'exp' && payload.exp * 1000 < Date.now() ? '  (EXPIRÉ)' : ''}`);
        result.textContent = `// En-tête\n${decode(parts[0])}\n\n// Contenu\n${decode(parts[1])}${dates.length ? '\n\n// Dates\n' + dates.join('\n') : ''}\n\n(signature non vérifiée)`;
      } catch { result.textContent = '⚠ JWT illisible'; }
    });
    return card('Décodeur JWT', h('div', { class: 'stack-sm' }, input, result));
  },

  regex() {
    const pattern = h('input', { class: 'input mono', placeholder: '^\\d{4}-\\d{2}$', 'aria-label': 'Expression' });
    const flags = h('input', { class: 'input mono input-xs', value: 'g', 'aria-label': 'Options', maxlength: 6 });
    const text = area({ placeholder: 'Texte à tester', rows: 6 });
    const result = h('div', { class: 'output regex-out' });
    const run = () => {
      clear(result);
      if (!pattern.value) return;
      let re;
      try { re = new RegExp(pattern.value, flags.value.includes('g') ? flags.value : flags.value + 'g'); } catch (e) { result.append(h('p', { class: 'error' }, e.message)); return; }
      let last = 0, count = 0;
      for (const m of text.value.matchAll(re)) {
        if (m[0] === '') break;
        result.append(text.value.slice(last, m.index), h('mark', {}, m[0]));
        last = m.index + m[0].length;
        if (++count > 500) break;
      }
      result.append(text.value.slice(last), h('p', { class: 'muted small' }, `${count} correspondance${count > 1 ? 's' : ''}`));
    };
    [pattern, flags, text].forEach((el) => el.addEventListener('input', run));
    return card('Testeur de regex', h('div', { class: 'stack-sm' }, h('div', { class: 'row' }, h('span', { class: 'mono' }, '/'), pattern, h('span', { class: 'mono' }, '/'), flags), text, result));
  },

  qr() {
    const input = h('input', { class: 'input', placeholder: 'https://glsc.fr', value: 'https://glsc.fr', 'aria-label': 'Texte du QR code' });
    const holder = h('div', { class: 'center' });
    let svg;
    const draw = () => { try { svg = qrSvg(input.value || ' ', 7); clear(holder, svg); } catch { clear(holder, h('p', { class: 'error' }, 'Texte trop long.')); } };
    input.addEventListener('input', draw);
    draw();
    return card('QR code', h('div', { class: 'stack-sm' }, input, holder, btn('Télécharger (SVG)', () => svg && downloadSvg(svg, 'qr.svg'), { iconName: 'download' })));
  },

  time() {
    const input = h('input', { class: 'input mono', placeholder: '1700000000 ou 2026-10-15 14:00', 'aria-label': 'Date ou timestamp' });
    const result = out();
    const run = () => {
      const v = input.value.trim();
      let d = /^\d{9,13}$/.test(v) ? new Date(v.length > 10 ? Number(v) : Number(v) * 1000) : new Date(v || Date.now());
      if (isNaN(d)) { result.textContent = '⚠ Date illisible'; return; }
      result.textContent = [
        `Timestamp (s)   ${Math.floor(d / 1000)}`, `Timestamp (ms)  ${d.getTime()}`, `ISO 8601        ${d.toISOString()}`,
        `Paris           ${d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'medium' })}`,
        `UTC             ${d.toUTCString()}`, `Relatif         ${rel(d)}`,
      ].join('\n');
    };
    const rel = (d) => { const s = Math.round((d - Date.now()) / 1000); const a = Math.abs(s); const u = a < 3600 ? [Math.round(a / 60), 'min'] : a < 86400 ? [Math.round(a / 3600), 'h'] : [Math.round(a / 86400), 'j']; return s < 0 ? `il y a ${u[0]} ${u[1]}` : `dans ${u[0]} ${u[1]}`; };
    input.addEventListener('input', run);
    run();
    return card('Convertisseur de dates', h('div', { class: 'stack-sm' }, input, btn('Maintenant', () => { input.value = ''; run(); }), result));
  },

  hash() {
    const input = area({ placeholder: 'Texte à hacher' });
    const result = out();
    const run = async () => {
      const data = new TextEncoder().encode(input.value);
      const lines = [];
      for (const algo of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
        const buf = await crypto.subtle.digest(algo, data);
        lines.push(`${algo.padEnd(8)} ${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
      }
      result.textContent = lines.join('\n');
    };
    input.addEventListener('input', run);
    run();
    return card('Empreintes (hash)', h('div', { class: 'stack-sm' }, input, result));
  },

  uuid() {
    const result = area({ readonly: true, rows: 6 });
    const gen = () => { result.value = Array.from({ length: 5 }, () => crypto.randomUUID()).join('\n'); };
    gen();
    return card('UUID v4', h('div', { class: 'stack-sm' }, result, h('div', { class: 'row' }, btn('Nouveaux', gen, { kind: 'primary', iconName: 'refresh-cw' }), copyBtn(result))));
  },

  json() {
    const input = area({ rows: 10, placeholder: '{"collez": "du JSON"}' });
    const run = (indent) => {
      try { input.value = JSON.stringify(JSON.parse(input.value), null, indent); toast('JSON valide ✓', 'good'); } catch (e) { toast('JSON invalide : ' + e.message, 'bad'); }
    };
    return card('Formateur JSON', h('div', { class: 'stack-sm' }, input,
      h('div', { class: 'row' }, btn('Indenter', () => run(2), { kind: 'primary' }), btn('Compacter', () => run(0)), copyBtn(input))));
  },

  url() {
    const input = area({ placeholder: 'Texte ou URL' });
    const result = area({ readonly: true });
    const parts = out();
    const run = (mode) => {
      try { result.value = mode === 'enc' ? encodeURIComponent(input.value) : decodeURIComponent(input.value); } catch { result.value = '⚠ Encodage invalide'; }
      try {
        const u = new URL(input.value.trim());
        parts.textContent = [`protocole  ${u.protocol}`, `hôte       ${u.host}`, `chemin     ${u.pathname}`, ...[...u.searchParams].map(([k, v]) => `?${k} = ${v}`), u.hash ? `ancre      ${u.hash}` : ''].filter(Boolean).join('\n');
      } catch { parts.textContent = ''; }
    };
    return card('Encodage d’URL', h('div', { class: 'stack-sm' }, input,
      h('div', { class: 'row' }, btn('Encoder', () => run('enc'), { kind: 'primary' }), btn('Décoder', () => run('dec')), copyBtn(result)), result, parts));
  },
};
