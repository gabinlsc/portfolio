// Trafic de tous les sites, lu dans les logs nginx par la sonde (remplace l'ancien admin.php).
import { h, clear, api, sectionHead, card, num, bytes, lineChart, bars, segmented, dayLabel, dateTimeFr, pill, emptyState } from '../lib.js';

let days = 7;
let host = '';

export async function render(root) {
  const box = h('div', {});
  root.append(box);
  const load = async () => {
    const t = await api(`traffic/summary?days=${days}&host=${encodeURIComponent(host)}`);
    clear(box, view(t, load));
  };
  await load();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected) load().catch(() => {}); }, 120000);
  return () => clearInterval(timer);
}

function view(t, reload) {
  const filters = [
    segmented([[1, 'Aujourd’hui'], [7, '7 jours'], [30, '30 jours']], days, (v) => { days = v; reload(); }, 'Période'),
    h('select', { class: 'input input-sm', 'aria-label': 'Site', onchange: (e) => { host = e.target.value; reload(); } },
      h('option', { value: '' }, 'Tous les sites'),
      (t.hosts || []).map((x) => h('option', { value: x, selected: x === host || null }, x))),
  ];
  const head = sectionHead('Trafic', 'Requêtes reçues par nginx sur tous les sites (robots exclus des visites).', ...filters);
  if (!t.ready) return h('div', {}, head, emptyState('Pas encore de données : la sonde lit les logs nginx chaque minute après l’installation (deploy5).'));
  const tot = t.totals;
  return h('div', { class: 'stack' }, head,
    h('div', { class: 'kpis kpis-big' },
      kpi(num(tot.views), 'pages vues', 'banana'), kpi(num(tot.visitors), 'visiteurs uniques', 'mint'),
      kpi(num(tot.requests), 'requêtes', 'sky'), kpi(num(tot.notfound), 'erreurs 404', 'peach'),
      kpi(num(tot.errors), 'erreurs 5xx', tot.errors ? 'coral' : 'paper'), kpi(bytes(tot.bytes), 'envoyés', 'lilac')),
    card(days === 1 ? 'Aujourd’hui' : `${days} derniers jours`, days === 1 ? h('p', { class: 'muted' }, 'Choisis 7 ou 30 jours pour la courbe.') : lineChart({
      labels: t.series.map((d) => dayLabel(d.day)),
      series: [{ name: 'Pages vues', color: 'sky', values: t.series.map((d) => d.views) }, { name: 'Visiteurs', color: 'mint', values: t.series.map((d) => d.visitors) }],
    })),
    h('div', { class: 'grid grid-2' },
      card('Par site', bars(t.by_host.map((r) => ({ label: r.host, value: r.views, sub: `· ${num(r.visitors)} visiteurs · ${num(r.requests)} req.` })), { color: 'banana' })),
      card('Pages les plus vues', bars(t.pages.map((r) => ({ label: r.path, sub: host ? '' : r.host, value: r.n })), { color: 'sky' })),
      card('D’où viennent les visiteurs', bars(t.referers.slice(0, 10).map((r) => ({ label: r.source, value: r.n })), { color: 'lilac' })),
      card('Appareils', bars(t.devices.map((r) => ({ label: r.device, value: r.n })), { color: 'mint' })),
      card('Codes de réponse', bars(t.status.map((r) => ({ label: `${r.class / 100}xx`, value: r.n, color: r.class >= 500 ? 'coral' : r.class >= 400 ? 'peach' : r.class >= 300 ? 'sky' : 'mint' })))),
      card('Pages introuvables (404)', bars(t.notfound.map((r) => ({ label: r.path, sub: host ? '' : r.host, value: r.n })), { color: 'peach', empty: 'Aucune 404 (hors robots et scanners).' }))),
    card('Dernières requêtes', h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Heure', 'Site', 'Chemin', 'Code', 'IP', 'Appareil'].map((c) => h('th', {}, c)))),
      h('tbody', {}, t.recent.map((r) => h('tr', { class: r.bot ? 'muted' : null },
        h('td', { class: 'nowrap' }, dateTimeFr(r.ts)), h('td', {}, r.host), h('td', { class: 'ellipsis path' }, `${r.method} ${r.path}`),
        h('td', {}, pill(r.status, r.status >= 500 ? 'coral' : r.status >= 400 ? 'peach' : r.status >= 300 ? 'sky' : 'mint', 'pill-sm')),
        h('td', { class: 'mono' }, r.ip), h('td', {}, r.device))))))));
}

const kpi = (value, label, color) => h('div', { class: ['kpi-card', `c-${color}`] }, h('b', {}, value), h('span', {}, label));
