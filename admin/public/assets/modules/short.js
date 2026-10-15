// Liens courts sur click.glsc.fr : création, QR code, compteur de clics et provenance.
import { h, clear, api, attempt, icon, btn, iconBtn, formModal, confirmBox, sectionHead, card, sparkline, num, ago, copy, modal, bars, emptyState, pill } from '../lib.js';
import qrcode from '../vendor/qrcode.js';

let base = 'https://click.glsc.fr/';

export async function render(root) {
  const data = await api('short/list');
  base = data.base;
  const box = h('div', {});
  root.append(sectionHead('Liens courts', 'click.glsc.fr/ton-nom → n’importe quelle adresse, avec le nombre de clics.',
    btn('Lien court', () => form(null, set), { kind: 'primary', iconName: 'plus' })), box);
  function set(links) {
    clear(box, links.length ? h('div', { class: 'stack' }, links.map((l) => row(l, set))) : emptyState('Aucun lien court. Crée le premier !'));
  }
  set(data.links);
}

function row(l, set) {
  const url = base + l.slug;
  return h('article', { class: ['card', 'short', !l.active && 'inactive'] },
    h('div', { class: 'short-main' },
      h('div', { class: 'short-url' },
        h('a', { href: url, target: '_blank', rel: 'noopener', class: 'short-slug' }, 'click.glsc.fr/', h('b', {}, l.slug)),
        !l.active ? pill('désactivé', 'coral') : null),
      h('p', { class: 'muted ellipsis' }, '→ ', l.target),
      l.note ? h('p', { class: 'small' }, l.note) : null),
    h('div', { class: 'short-stats' },
      h('div', { class: 'kpi' }, h('b', {}, num(l.clicks)), h('span', {}, 'clics')),
      sparkline(l.spark, { cls: 'c-text-sky' }),
      h('small', { class: 'muted' }, 'Dernier : ' + ago(l.last_click))),
    h('div', { class: 'short-actions' },
      iconBtn('copy', 'Copier le lien', () => copy(url, 'Lien copié')),
      iconBtn('qr-code', 'QR code', () => showQr(url)),
      iconBtn('chart-column', 'Provenance des clics', () => stats(l)),
      iconBtn('pencil', 'Modifier', () => form(l, set)),
      iconBtn('trash-2', 'Supprimer', async () => {
        if (!(await confirmBox(`Supprimer click.glsc.fr/${l.slug} ? Le lien ne marchera plus.`))) return;
        const r = await attempt(() => api('short/delete', { body: { id: l.id } }));
        if (r) set(r.links);
      })));
}

function form(l, set) {
  formModal({
    title: l ? 'Modifier le lien court' : 'Nouveau lien court',
    fields: [
      { name: 'target', label: 'Adresse de destination', type: 'url', value: l?.target, required: true, placeholder: 'https://…' },
      { name: 'slug', label: 'Nom court (vide = au hasard)', value: l?.slug, max: 40, placeholder: 'cv, linkedin, portfolio…', hint: 'Lettres minuscules, chiffres, - et _.' },
      { name: 'note', label: 'Note (pour toi)', value: l?.note, max: 120 },
      { name: 'active', label: 'Actif', type: 'checkbox', value: l ? !!l.active : true },
    ],
    onSubmit: async (v) => set((await api('short/save', { body: { id: l?.id, ...v } })).links),
  });
}

export function qrSvg(text, scale = 6) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), m = 2, size = (n + m * 2) * scale;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${(c + m) * scale},${(r + m) * scale}h${scale}v${scale}h-${scale}z`;
  return h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'qr', role: 'img', 'aria-label': 'QR code de ' + text },
    h('rect', { width: size, height: size, fill: '#fff' }), h('path', { d, fill: '#111' }));
}

export function downloadSvg(svg, name) {
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function showQr(url) {
  const svg = qrSvg(url, 8);
  modal({ title: 'QR code', body: h('div', { class: 'center stack-sm' }, svg, h('p', { class: 'muted' }, url)),
    actions: [btn('Télécharger (SVG)', () => downloadSvg(svg, 'qr-' + url.split('/').pop() + '.svg'), { kind: 'primary', iconName: 'download' })] });
}

async function stats(l) {
  const s = await attempt(() => api('short/stats?id=' + l.id));
  if (!s) return;
  modal({ title: `click.glsc.fr/${l.slug} · 90 jours`, body: h('div', { class: 'stack' },
    h('div', {}, h('h3', {}, 'Provenance'), bars(s.referers.map((r) => ({ label: r.ref, value: r.n })), { empty: 'Aucun clic.' })),
    h('div', {}, h('h3', {}, 'Appareils'), bars(s.devices.map((r) => ({ label: r.device, value: r.n })), { color: 'mint', empty: 'Aucun clic.' }))) });
}
