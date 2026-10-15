// Qui regarde le CV et la page Projets : provenance (LinkedIn, Google…), appareil, langue, et clics importants.
import { h, clear, api, sectionHead, card, num, lineChart, bars, segmented, dayLabel, dateTimeFr, emptyState, pill } from '../lib.js';

const EVENTS = {
  print: 'Impression / PDF du CV', email: 'Clic sur l’email', email_copy: 'Email copié', phone: 'Clic sur le téléphone',
  linkedin: 'Clic LinkedIn', github: 'Clic GitHub', site: 'Clic vers glsc.fr', project: 'Clic sur un projet',
};
const eventLabel = (e) => {
  const [kind, detail] = e.split(':');
  return (EVENTS[kind] || kind) + (detail ? ` · ${detail}` : '');
};
const LANGS = { fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien', pt: 'Portugais', nl: 'Néerlandais', '?': 'Inconnue' };

let days = 30;

export async function render(root) {
  const box = h('div', {});
  root.append(box);
  const load = async () => clear(box, view(await api('cvstats/summary?days=' + days), load));
  await load();
}

function view(d, reload) {
  const head = sectionHead('Stats CV & Projets', 'Visites de cv.glsc.fr et share.glsc.fr, sans cookie ni traceur externe.',
    segmented([[7, '7 jours'], [30, '30 jours'], [90, '90 jours']], days, (v) => { days = v; reload(); }, 'Période'));
  if (!d.ready) return h('div', {}, head, emptyState('Pas encore de données (la sonde démarre après deploy5).'));
  return h('div', { class: 'stack' }, head, d.sites.map((s) => site(s)));
}

function site(s) {
  return h('section', { class: 'stack' },
    h('h2', { class: 'section-title' }, s.label, h('small', { class: 'muted' }, ' · ' + s.host)),
    h('div', { class: 'kpis kpis-big' },
      h('div', { class: 'kpi-card c-banana' }, h('b', {}, num(s.views)), h('span', {}, 'pages vues')),
      h('div', { class: 'kpi-card c-mint' }, h('b', {}, num(s.visitors)), h('span', {}, 'visiteurs')),
      h('div', { class: 'kpi-card c-lilac' }, h('b', {}, num(s.events.reduce((a, e) => a + e.n, 0))), h('span', {}, 'clics suivis'))),
    card('Visites par jour', lineChart({ labels: s.series.map((x) => dayLabel(x.day)), series: [{ name: 'Pages vues', color: 'sky', values: s.series.map((x) => x.views) }], height: 150 })),
    h('div', { class: 'grid grid-2' },
      card('Provenance', bars(s.sources.slice(0, 8).map((r) => ({ label: r.source, value: r.n })), { color: 'lilac' })),
      card('Clics importants', bars(s.events.map((e) => ({ label: eventLabel(e.event), value: e.n })), { color: 'banana', empty: 'Aucun clic suivi sur la période.' })),
      card('Appareils', bars(s.devices.map((r) => ({ label: r.device, value: r.n })), { color: 'mint' })),
      card('Langue du navigateur', bars(s.langs.map((r) => ({ label: LANGS[r.lang] || r.lang, value: r.n })), { color: 'sky' }))),
    card('Dernières visites', s.recent.length ? h('ul', { class: 'rows' }, s.recent.map((r) => h('li', {},
      h('span', { class: 'nowrap muted' }, dateTimeFr(r.ts)), h('span', { class: 'grow' }, r.source), pill(r.device, 'paper', 'pill-sm'), h('small', { class: 'muted' }, LANGS[r.lang] || r.lang || ''))))
      : h('p', { class: 'muted' }, 'Aucune visite sur la période.')));
}
