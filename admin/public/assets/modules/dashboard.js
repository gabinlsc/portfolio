// Accueil : l'essentiel de tous les modules en un coup d'œil.
import { h, api, icon, card, gauge, columns, pill, num, pct, duration, countdown, dayLabel, ago, sectionHead } from '../lib.js';

const more = (href, label = 'Voir') => h('a', { class: 'more', href }, label, icon('arrow-right'));

export async function render(root) {
  const d = await api('dashboard/summary');
  const now = new Date();
  const hello = now.getHours() < 18 ? 'Salut' : 'Bonsoir';

  root.append(
    sectionHead(`${hello} Gabin 👋`, now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })),
    h('div', { class: 'quicklinks' }, d.links.map((l) => h('a', { class: ['sticker', `c-${l.color}`], href: l.url, target: '_blank', rel: 'noopener' }, l.label, icon('external-link')))),
    alerts(d.alerts),
    h('div', { class: 'grid grid-dash' },
      serverCard(d.health),
      trafficCard(d.traffic),
      gamesCard(d.games, d.sites),
      kanbanCard(d.kanban),
      deadlinesCard(d.deadlines),
      securityCard(d.ssh_fails, d.files),
      commitsCard(d.commits)));
  // rafraîchit discrètement toutes les 60 s
  const timer = setInterval(async () => {
    if (document.hidden || !root.isConnected) return;
    try {
      const fresh = await api('dashboard/summary');
      const old = root.querySelector('.grid-dash');
      if (old) old.replaceWith(h('div', { class: 'grid grid-dash' }, serverCard(fresh.health), trafficCard(fresh.traffic), gamesCard(fresh.games, fresh.sites),
        kanbanCard(fresh.kanban), deadlinesCard(fresh.deadlines), securityCard(fresh.ssh_fails, fresh.files), commitsCard(fresh.commits)));
      root.querySelector('.alerts')?.replaceWith(alerts(fresh.alerts));
    } catch { /* silencieux */ }
  }, 60000);
  return () => clearInterval(timer);
}

function alerts(list) {
  if (!list.length) return h('div', { class: 'alerts alerts-ok' }, icon('circle-check'), 'Tout roule : aucun problème détecté.');
  return h('div', { class: 'alerts' }, list.map((a) => h('p', { class: ['alert', `alert-${a.level}`] }, a.level === 'bad' ? icon('circle-alert') : icon('triangle-alert'), a.text)));
}

function serverCard(hl) {
  if (!hl) return card('Serveur', h('p', { class: 'muted' }, 'En attente des premières mesures.'), { actions: more('#/health') });
  const memP = pct(hl.mem.used, hl.mem.total), diskP = pct(hl.disk.used, hl.disk.total);
  return card('Serveur', h('div', { class: 'stack-sm' },
    h('div', { class: 'meter' }, h('span', {}, 'CPU'), gauge(hl.cpu, { label: 'CPU' }), h('b', {}, `${Math.round(hl.cpu)} %`)),
    h('div', { class: 'meter' }, h('span', {}, 'RAM'), gauge(memP, { label: 'RAM' }), h('b', {}, `${memP} %`)),
    h('div', { class: 'meter' }, h('span', {}, 'Disque'), gauge(diskP, { warn: 75, bad: 85, label: 'Disque' }), h('b', {}, `${diskP} %`)),
    h('p', { class: 'muted small' }, `En ligne depuis ${duration(hl.uptime)} · charge ${hl.load[0].toFixed(2)}`)), { actions: more('#/health') });
}

function trafficCard(t) {
  if (!t) return card('Trafic', h('p', { class: 'muted' }, 'En attente des premières mesures.'), { actions: more('#/traffic') });
  const diff = t.yesterday ? Math.round((100 * (t.today - t.yesterday)) / t.yesterday) : null;
  return card('Trafic aujourd’hui', h('div', {},
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', {}, num(t.today)), h('span', {}, 'pages vues')),
      h('div', { class: 'kpi' }, h('b', {}, num(t.visitors)), h('span', {}, 'visiteurs')),
      diff !== null ? h('div', { class: 'kpi' }, h('b', { class: diff >= 0 ? 'up' : 'down' }, `${diff >= 0 ? '+' : ''}${diff} %`), h('span', {}, 'vs hier')) : null),
    columns(t.week.map((d) => ({ label: dayLabel(d.day), value: d.views })), { color: 'sky' })), { actions: more('#/traffic') });
}

function gamesCard(games, sites) {
  const state = (s) => (s === 'running' ? pill('en ligne', 'mint') : pill(s || '?', 'coral'));
  return card('Jeux & sites', h('div', { class: 'stack-sm' },
    games.length ? h('ul', { class: 'rows' }, games.map((g) => h('li', {}, h('b', {}, g.name), state(g.state), h('span', { class: 'muted' }, `${g.players} connecté${g.players > 1 ? 's' : ''}`))))
      : h('p', { class: 'muted' }, 'Pas d’info sur les conteneurs.'),
    sites.length ? h('div', { class: 'dots' }, sites.map((s) => h('span', { class: ['dot-item'], title: s.status }, h('i', { class: s.status === 'up' ? 'c-mint' : s.status === 'down' ? 'c-coral' : 'c-banana' }), s.name))) : null),
    { actions: more('#/games') });
}

function kanbanCard(k) {
  if (!k.board) return card('Kanban', h('p', { class: 'muted' }, 'Aucun tableau.'), { actions: more('#/kanban') });
  return card(`Kanban · ${k.board.name}`, h('div', { class: 'kanban-mini' }, k.columns.map((c) => h('div', { class: ['mini-col', `c-${c.color}`] }, h('b', {}, num(c.n)), h('span', {}, c.name)))),
    { actions: more('#/kanban', 'Ouvrir') });
}

function deadlinesCard(list) {
  return card('Prochaines échéances', list.length ? h('ul', { class: 'rows' }, list.map((dl) => {
    const c = countdown(dl.due);
    return h('li', {}, h('span', { class: 'grow' }, h('b', {}, dl.title), dl.course ? h('small', { class: 'muted' }, ' · ' + dl.course) : null), pill(c.text, c.kind === 'bad' ? 'coral' : c.kind === 'warn' ? 'banana' : 'mint'));
  })) : h('p', { class: 'muted' }, 'Rien à rendre, profite 🎉'), { actions: more('#/school') });
}

function securityCard(fails, files) {
  return card('Sécurité & partage', h('div', { class: 'kpis' },
    h('div', { class: 'kpi' }, h('b', {}, fails === null ? '–' : num(fails)), h('span', {}, 'échecs SSH (24 h)')),
    h('div', { class: 'kpi' }, h('b', {}, num(files)), h('span', {}, 'fichiers partagés'))), { actions: more('#/security') });
}

function commitsCard(commits) {
  return card('Derniers commits', commits.length ? h('ul', { class: 'rows' }, commits.map((c) => h('li', {},
    h('span', { class: 'grow' }, h('b', {}, c.repo), ' ', h('span', { class: 'muted' }, c.message)), h('small', { class: 'muted nowrap' }, ago(c.at)))))
    : h('p', { class: 'muted' }, 'Pas encore récupérés.'), { actions: more('#/github') });
}
