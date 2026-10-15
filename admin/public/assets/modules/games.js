// Jeux en direct : état des conteneurs, joueurs connectés, ressources, et bouton de redémarrage.
import { h, clear, api, attempt, sectionHead, card, num, bytes, pill, btn, confirmBox, emptyState, lineChart, ago, icon } from '../lib.js';

const GAMES = { uno: 'UNO', president: 'Le Président', vortex: 'Vortex' };

export async function render(root) {
  const box = h('div', {});
  root.append(box);
  const load = async () => clear(box, view(await api('games/live'), load));
  await load();
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
