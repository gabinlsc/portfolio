// Jeux en direct : état des conteneurs, joueurs connectés, ressources, bouton de redémarrage et modération des classements.
import { h, clear, api, attempt, sectionHead, card, num, bytes, pill, btn, confirmBox, emptyState, lineChart, ago, icon, segmented } from '../lib.js';

const GAMES = { uno: 'UNO', president: 'Le Président', vortex: 'Vortex' };

export async function render(root) {
  const box = h('div', {});
  const boards = h('div', {});
  root.append(box, boards);
  const load = async () => clear(box, view(await api('games/live'), load));
  await load();
  moderation(boards).catch(() => {});
  const timer = setInterval(() => { if (!document.hidden && root.isConnected) load().catch(() => {}); }, 30000);
  return () => clearInterval(timer);
}

function view(d, reload) {
  const head = sectionHead('Jeux en direct', d.docker ? `Mis à jour ${ago(d.docker.at)}` : '');
  const list = d.docker?.containers || [];
  if (!list.length) return h('div', {}, head, emptyState('Aucun conteneur de jeu trouvé (deploy4 installe les jeux, deploy5 la sonde).'));
  const hist = Object.entries(d.history || {});
  return h('div', { class: 'stack' }, head,
    h('div', { class: 'grid grid-3' }, list.map((c) => gameCard(c, d.pending.includes(c.service), reload))),
    hist.length ? card('Joueurs connectés (24 h)', lineChart({
      labels: hist[0][1].map((p) => new Date(p.t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })),
      series: hist.map(([g, pts], i) => ({ name: GAMES[g] || g, color: ['banana', 'sky', 'lilac'][i % 3], values: pts.map((p) => p.conns) })),
    })) : null);
}

function gameCard(c, pending, reload) {
  const running = c.state === 'running';
  return h('section', { class: ['card', 'game', running ? 'c-paper' : 'c-coral'] },
    h('div', { class: 'card-head' }, h('h2', {}, c.label || c.name), pill(running ? 'en ligne' : c.state, running ? 'mint' : 'coral')),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', {}, num(c.conns)), h('span', {}, `joueur${c.conns > 1 ? 's' : ''} connecté${c.conns > 1 ? 's' : ''}`)),
      h('div', { class: 'kpi' }, h('b', {}, c.cpu != null ? `${c.cpu.toFixed(1)} %` : '–'), h('span', {}, 'CPU')),
      h('div', { class: 'kpi' }, h('b', {}, c.mem != null ? bytes(c.mem) : '–'), h('span', {}, 'mémoire'))),
    h('p', { class: 'muted small' }, c.status, c.restarts ? ` · ${c.restarts} redémarrage(s) auto` : ''),
    h('div', { class: 'row' },
      c.domain ? h('a', { class: 'btn', href: 'https://' + c.domain, target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, 'Ouvrir')) : null,
      btn(pending ? 'Redémarrage…' : 'Redémarrer', async () => {
        if (!(await confirmBox(`Redémarrer ${c.label} ? Les parties en cours seront coupées.`, { ok: 'Redémarrer' }))) return;
        if (await attempt(() => api('games/restart', { body: { game: c.service } }), (r) => r.message)) setTimeout(reload, 1500);
      }, { kind: 'danger', iconName: 'rotate-cw' })));
}

// ---------------------------------------------------------------- classements (games.glsc.fr)
async function moderation(box) {
  let game = 'uno';
  let period = 'all';
  const draw = (d) => {
    const g = d.board?.games?.[game]?.[period];
    const names = g?.names || [];
    const rows = names.length ? h('ul', { class: 'rows' }, names.map((n) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, n.name), ' ',
        h('small', { class: 'muted' }, `${num(n.played)} partie${n.played > 1 ? 's' : ''} · ${num(n.wins)} victoire${n.wins > 1 ? 's' : ''}` +
          (n.kills != null ? ` · ${num(n.kills)} élim.` : '') + ` · ${ago(n.last)}`)),
      n.hidden === 'filtré' ? pill('filtré automatiquement', 'paper', 'pill-sm') : null,
      n.hidden === 'filtré' ? null : btn(n.hidden ? 'Réafficher' : 'Masquer', async () => {
        const r = await attempt(() => api('games/hide', { body: { key: n.key, hidden: !n.hidden } }), n.hidden ? 'Pseudo réaffiché' : 'Pseudo masqué');
        if (r) { n.hidden = n.hidden ? null : 'masqué'; draw(d); }
      }, n.hidden ? { iconName: 'eye' } : { kind: 'danger', iconName: 'eye-off' }))))
      : h('p', { class: 'muted' }, 'Aucune partie enregistrée pour l’instant.');
    clear(box, card('Classements de games.glsc.fr', h('div', { class: 'stack-sm' },
      h('p', { class: 'muted small' }, 'Tous les pseudos qui ont joué sur la période (100 au plus). Un pseudo masqué disparaît du classement public à la prochaine mesure (1 min). Les pseudos injurieux et les pseudos par défaut (« Joueur 2 »…) sont filtrés automatiquement.'),
      h('div', { class: 'row' },
        segmented(Object.entries(GAMES), game, (v) => { game = v; draw(d); }, 'Jeu'),
        segmented([['week', '7 jours'], ['all', 'Depuis toujours']], period, (v) => { period = v; draw(d); }, 'Période')),
      g ? h('p', {}, pill(`${num(g.matches)} parties`, 'banana'), ' ', pill(`${num(g.players)} joueurs`, 'sky')) : null,
      rows), { cls: 'span-2', actions: h('a', { class: 'more', href: 'https://games.glsc.fr/#classements', target: '_blank', rel: 'noopener' }, 'Voir', icon('external-link')) }));
  };
  draw(await api('games/board'));
}
