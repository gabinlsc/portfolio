// Joueurs : qui joue, quand, à quoi (calculé par la sonde à partir des parties enregistrées pour les classements) et signalements des joueurs.
import { h, api, sectionHead, card, num, pill, ago, bars, columns, lineChart, emptyState } from '../lib.js';

const GAME_LABELS = { plus4: '+4', president: 'Le Président', petitbac: 'Petit Bac', vortex: 'Vortex', site: 'Site', inconnu: 'Jeu ?' };

export async function render(root) {
  const box = h('div', {});
  root.append(box);
  const load = async () => {
    const d = await api('players/stats');
    box.replaceChildren(view(d));
  };
  await load();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected) load().catch(() => {}); }, 60000);
  return () => clearInterval(timer);
}

function kpi(value, label, color) {
  return h('div', { class: ['kpi-tile', `c-${color}`] }, h('b', {}, value), h('span', {}, label));
}

function view(d) {
  if (d.empty) {
    return h('div', {}, sectionHead('Joueurs', 'Qui joue, quand, à quoi.'),
      emptyState('Pas encore de statistiques : elles apparaissent dès que la sonde aura relu les premières parties.'));
  }
  const t = d.totals;
  const days = d.daily.map((x) => new Date(x.day + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));

  const kpis = h('div', { class: 'kpi-grid' },
    kpi(num(t.active7), 'joueurs actifs (7 jours)', 'banana'),
    kpi(num(t.active30), 'joueurs actifs (30 jours)', 'mint'),
    kpi(num(t.new7), 'nouveaux cette semaine', 'sky'),
    kpi(num(t.returning7), 'habitués cette semaine', 'lilac'),
    kpi(num(t.profiles), 'profils créés', 'peach'),
    kpi(`${t.profile_share30} %`, 'des parties jouées avec un profil (30 j)', 'paper'),
    kpi(num(t.reports7), 'bugs signalés (7 jours)', t.reports7 ? 'coral' : 'paper'));

  const retention = d.retention.pct == null
    ? h('p', { class: 'muted' }, 'Pas encore assez de recul : il faut des joueurs apparus il y a 8 à 30 jours.')
    : h('div', { class: 'stack-sm' },
      h('p', {}, h('b', { class: 'big' }, `${d.retention.pct} %`), ` des joueurs arrivés il y a 8 à 30 jours sont revenus au moins un autre jour (${num(d.retention.back)} sur ${num(d.retention.cohort)}).`),
      h('p', { class: 'muted small' }, 'Un joueur = un profil, ou à défaut un pseudo. Les invités qui changent de pseudo comptent plusieurs fois : le vrai chiffre est un peu meilleur.'));

  const games = bars(d.games.map((g) => ({ label: g.label, value: g.matches30, sub: `${num(g.players30)} joueurs · ${g.avg_players} par partie` })),
    { empty: 'Aucune partie sur 30 jours.' });
  const best = bars(d.top.map((p) => ({ label: p.name + (p.profil ? ' ✓' : '') + (p.hidden ? ' (masqué)' : ''), value: p.matches, sub: `${num(p.wins)} victoire${p.wins > 1 ? 's' : ''}` })),
    { color: 'banana', empty: 'Personne sur 30 jours.' });

  const reports = d.reports.length
    ? h('ul', { class: 'rows' }, d.reports.map((r) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, r.name || 'invité'), ' ', pill(GAME_LABELS[r.game] || r.game, 'banana', 'pill-sm'), ' ',
        r.room ? h('code', {}, r.room) : null, ' ', h('small', { class: 'muted' }, ago(r.t)),
        h('br', {}), h('span', { class: 'report-text' }, r.message),
        r.ua ? h('br', {}) : null, r.ua ? h('small', { class: 'muted' }, String(r.ua).slice(0, 90)) : null))))
    : h('p', { class: 'muted' }, 'Aucun signalement pour l’instant.');

  return h('div', { class: 'stack' }, sectionHead('Joueurs', `Mis à jour ${ago(d.at)}`), kpis,
    h('div', { class: 'grid grid-2' },
      card('Parties et joueurs par jour (30 jours)', lineChart({ labels: days, series: [
        { name: 'Parties', color: 'banana', values: d.daily.map((x) => x.matches) },
        { name: 'Joueurs', color: 'sky', values: d.daily.map((x) => x.players) }] }), { cls: 'span-2' }),
      card('Heures de pointe', columns(d.hours.map((v, i) => ({ label: String(i), value: v, title: `${i} h : ${v} partie${v > 1 ? 's' : ''}` })), { color: 'mint' })),
      card('Fidélité', retention),
      card('Jeux (30 jours)', games),
      card('Joueurs les plus actifs (30 jours)', best),
      card('Signalements des joueurs', reports, { cls: 'span-2' })));
}
