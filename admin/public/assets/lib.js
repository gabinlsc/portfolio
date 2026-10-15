// Briques communes de l'interface admin : DOM sûr (jamais d'innerHTML avec des données), API, fenêtres, graphiques.
import { icon } from './icons.js';

export { icon };

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'g', 'text', 'title']);

/** h('div', {class: 'x', onclick: fn}, 'texte', autreNoeud) — le texte est toujours inséré comme texte. */
export function h(tag, props, ...children) {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value' && !svg) el.value = v;
    else if (k === 'checked' && !svg) el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------------------------------------------------------------- API
const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

export async function api(path, { method, body, form } = {}) {
  const opts = { method: method || (body || form ? 'POST' : 'GET'), headers: { 'X-CSRF-Token': csrf() }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch('/api/' + path, opts);
  } catch {
    throw new Error('Serveur injoignable. Vérifie ta connexion.');
  }
  if (res.status === 401) {
    toast('Session expirée : reconnexion…', 'bad');
    setTimeout(() => location.reload(), 1200);
    throw new Error('Session expirée.');
  }
  const data = await res.json().catch(() => ({ error: 'Réponse illisible du serveur.' }));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/** Exécute une action et affiche l'erreur éventuelle en notification. */
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(typeof success === 'function' ? success(r) : success, 'good');
    return r;
  } catch (e) {
    toast(e.message, 'bad');
    return null;
  }
}

// ---------------------------------------------------------------- notifications
export function toast(text, kind = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) document.body.appendChild((box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = h('div', { class: ['toast', `toast-${kind}`] }, text);
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4200);
}

// ---------------------------------------------------------------- fenêtres
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const prev = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', key);
    prev?.focus?.();
    onClose?.();
  };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('div', { class: ['modal', wide && 'modal-wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, panel);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', key);
  setTimeout(() => (panel.querySelector('input, textarea, select, button.btn') || panel).focus(), 0);
  return close;
}

export function confirmBox(text, { ok = 'Supprimer', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal({
      title: 'Confirmer',
      body: h('p', {}, text),
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Annuler'),
        h('button', { class: ['btn', danger ? 'btn-danger' : 'btn-primary'], type: 'button', onclick: () => { done = true; resolve(true); close(); } }, ok),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/**
 * Formulaire dans une fenêtre. fields : [{name, label, type, value, options, required, placeholder, rows, hint}]
 * onSubmit(valeurs) peut lever une erreur : elle s'affiche et la fenêtre reste ouverte.
 */
export function formModal({ title, fields, submit = 'Enregistrer', onSubmit, extra = [] }) {
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const inputs = {};
  const form = h('form', { class: 'stack', novalidate: false },
    fields.map((f) => {
      let input;
      const common = { name: f.name, id: 'f-' + f.name, required: f.required || null, placeholder: f.placeholder || null };
      if (f.type === 'textarea') input = h('textarea', { ...common, class: 'input', rows: f.rows || 4 }, f.value ?? '');
      else if (f.type === 'select') input = h('select', { ...common, class: 'input' }, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') || null }, l)));
      else if (f.type === 'colors') input = colorPicker(f.name, f.value || 'banana');
      else if (f.type === 'checkbox') input = h('input', { ...common, type: 'checkbox', checked: !!f.value });
      else input = h('input', { ...common, class: 'input', type: f.type || 'text', value: f.value ?? '', maxlength: f.max || null, autocomplete: 'off' });
      inputs[f.name] = input;
      if (f.type === 'checkbox') return h('label', { class: 'check' }, input, h('span', {}, f.label));
      return h('label', { class: 'field', for: 'f-' + f.name }, h('span', {}, f.label), input, f.hint ? h('small', { class: 'hint' }, f.hint) : null);
    }),
    extra, error);
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, submit);
  form.appendChild(h('div', { class: 'modal-actions' }, btn));
  const close = modal({ title, body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [name, el] of Object.entries(inputs)) {
      values[name] = el.type === 'checkbox' ? el.checked : el.dataset?.value ?? el.value;
    }
    btn.disabled = true;
    error.hidden = true;
    try {
      await onSubmit(values);
      close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  return close;
}

export const COLORS = ['paper', 'banana', 'mint', 'lilac', 'sky', 'coral', 'peach'];
const COLOR_NAMES = { paper: 'Blanc', banana: 'Jaune', mint: 'Vert', lilac: 'Lilas', sky: 'Bleu', coral: 'Corail', peach: 'Pêche' };

function colorPicker(name, value) {
  const box = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Couleur', dataset: { value } });
  for (const c of COLORS) {
    box.appendChild(h('button', {
      type: 'button', class: ['swatch', `c-${c}`], role: 'radio', 'aria-checked': String(c === value), 'aria-label': COLOR_NAMES[c],
      onclick: (e) => {
        box.dataset.value = c;
        box.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === e.currentTarget)));
      },
    }));
  }
  return box;
}

// ---------------------------------------------------------------- formats
const nf = new Intl.NumberFormat('fr-FR');
export const num = (n) => nf.format(Math.round(n || 0));
export const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

export function bytes(n) {
  if (!n) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return (i ? (n / 1024 ** i).toFixed(1).replace('.', ',') : n) + ' ' + u[i];
}

export function ago(ts) {
  if (!ts) return 'jamais';
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  return dateFr(ts);
}

export const dateFr = (ts) => new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
export const dateTimeFr = (ts) => new Date(ts * 1000).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function duration(sec) {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} j ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}

/** « dans 3 j », « aujourd'hui », « en retard de 2 j » pour une date AAAA-MM-JJ[THH:MM]. */
export function countdown(due) {
  const d = new Date(due.length === 10 ? due + 'T23:59' : due);
  const days = Math.ceil((d - new Date()) / 86400000);
  if (d < new Date()) return { text: days === 0 ? 'en retard' : `en retard de ${-days} j`, kind: 'bad' };
  if (days <= 1) return { text: d.toDateString() === new Date().toDateString() ? 'aujourd’hui' : 'demain', kind: 'bad' };
  return { text: `dans ${days} j`, kind: days <= 7 ? 'warn' : 'ok' };
}

export const dayLabel = (day) => new Date(day + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });

// ---------------------------------------------------------------- graphiques (SVG, sans bibliothèque)
export function sparkline(values, { w = 120, hgt = 32, cls = '' } = {}) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(hgt - 3 - (v / max) * (hgt - 6)).toFixed(1)}`).join(' ');
  return h('svg', { class: ['spark', cls], viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, 'aria-hidden': 'true' },
    h('polyline', { points: pts, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

/** Histogramme vertical : [{label, value, title}] */
export function columns(items, { color = 'banana', unit = '' } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h('div', { class: 'cols', role: 'img', 'aria-label': items.map((i) => `${i.label} : ${num(i.value)}${unit}`).join(', ') },
    items.map((i) => h('div', { class: 'col', title: i.title || `${i.label} : ${num(i.value)}${unit}` },
      h('span', { class: 'col-val' }, i.value ? num(i.value) : ''),
      h('span', { class: ['col-bar', `c-${color}`], style: { height: `${Math.max(2, (100 * i.value) / max)}%` } }),
      h('span', { class: 'col-label' }, i.label))));
}

/** Barres horizontales classées : [{label, value, sub}] */
export function bars(items, { color = 'sky', empty = 'Rien pour l’instant.' } = {}) {
  if (!items.length) return h('p', { class: 'muted' }, empty);
  const max = Math.max(1, ...items.map((i) => i.value));
  return h('ul', { class: 'bars' }, items.map((i) => h('li', {},
    h('span', { class: ['bar-fill', `c-${i.color || color}`], style: { width: `${(100 * i.value) / max}%` } }),
    h('span', { class: 'bar-label', title: i.label }, i.label, i.sub ? h('small', {}, ' ' + i.sub) : null),
    h('span', { class: 'bar-val' }, num(i.value)))));
}

/** Courbes sur une grille : series [{name, color, values}], labels [] (axe X). Valeurs en % si max fourni. */
export function lineChart({ labels, series, max, height = 180, unit = '' }) {
  const W = 600, H = height, pad = { l: 34, r: 8, t: 10, b: 22 };
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v != null)));
  const n = Math.max(1, labels.length - 1);
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - Math.min(v, top) / top);
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': series.map((s) => s.name).join(', ') });
  for (const f of [0, 0.5, 1]) {
    svg.appendChild(h('line', { x1: pad.l, x2: W - pad.r, y1: y(top * f), y2: y(top * f), class: 'grid' }));
    svg.appendChild(h('text', { x: pad.l - 6, y: y(top * f) + 4, class: 'axis', 'text-anchor': 'end' }, num(top * f) + unit));
  }
  const every = Math.ceil(labels.length / 6);
  labels.forEach((l, i) => { if (i % every === 0) svg.appendChild(h('text', { x: x(i), y: H - 5, class: 'axis', 'text-anchor': 'middle' }, l)); });
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
    svg.appendChild(h('polyline', { points: pts, class: ['line', `s-${s.color}`], fill: 'none' }));
  }
  const legend = h('div', { class: 'legend' }, series.map((s) => h('span', {}, h('i', { class: `c-${s.color}` }), s.name)));
  return h('div', { class: 'chart-wrap' }, svg, legend);
}

/** Jauge horizontale avec seuils. */
export function gauge(value, { warn = 75, bad = 90, label = '' } = {}) {
  const v = Math.max(0, Math.min(100, value || 0));
  const kind = v >= bad ? 'coral' : v >= warn ? 'banana' : 'mint';
  return h('div', { class: 'gauge', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(v), 'aria-label': label },
    h('span', { class: ['gauge-fill', `c-${kind}`], style: { width: `${v}%` } }));
}

// ---------------------------------------------------------------- petits composants
export const pill = (text, color = 'paper', extra = '') => h('span', { class: ['pill', `c-${color}`, extra] }, text);

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', {}, text), action || null);
}

export function sectionHead(title, subtitle, ...actions) {
  return h('header', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function card(title, body, { color, actions, cls } = {}) {
  return h('section', { class: ['card', color && `c-${color}`, cls] },
    title ? h('div', { class: 'card-head' }, h('h2', {}, title), actions || null) : null,
    body);
}

export function btn(label, onclick, { kind = '', iconName, type = 'button', title } = {}) {
  return h('button', { class: ['btn', kind && `btn-${kind}`], type, onclick, title: title || null },
    iconName ? icon(iconName) : null, label ? h('span', {}, label) : null);
}

export function iconBtn(name, label, onclick) {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
}

export async function copy(text, what = 'Copié') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} ✓`, 'good');
  } catch {
    toast('Copie impossible : sélectionne le texte à la main.', 'bad');
  }
}

/** Segments (choix exclusifs) : options [[valeur, libellé]] */
export function segmented(options, value, onchange, label) {
  const box = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  for (const [v, l] of options) {
    box.appendChild(h('button', { type: 'button', class: ['seg', String(v) === String(value) && 'active'], 'aria-pressed': String(String(v) === String(value)),
      onclick: () => onchange(v) }, l));
  }
  return box;
}
