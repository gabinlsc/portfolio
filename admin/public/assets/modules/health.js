// Santé du serveur : CPU, mémoire, disque, services, certificats HTTPS, processus gourmands.
import { h, clear, api, sectionHead, card, gauge, num, bytes, pct, duration, lineChart, segmented, pill, emptyState, dateFr, ago } from '../lib.js';

let range = '24h';

export async function render(root) {
  const box = h('div', {});
  root.append(box);
  const load = async () => clear(box, view(await api('health/now?range=' + range), load));
  await load();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected) load().catch(() => {}); }, 60000);
  return () => clearInterval(timer);
}

function view(d, reload) {
  const head = sectionHead('Santé du serveur', d.now ? `Mesuré ${ago(d.now.at)} · VPS IONOS` : 'VPS IONOS');
  if (!d.now) return h('div', {}, head, emptyState('Pas encore de mesures : la sonde démarre après deploy5.'));
  const n = d.now;
  const memP = pct(n.mem.used, n.mem.total), swapP = pct(n.swap.used, n.swap.total), diskP = pct(n.disk.used, n.disk.total);
  const labels = d.history.map((p) => {
    const t = new Date(p.t * 1000);
    return range === '7d' ? t.toLocaleDateString('fr-FR', { weekday: 'short' }) : t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  });
  return h('div', { class: 'stack' }, head,
    h('div', { class: 'grid grid-4' },
      meterCard('CPU', `${Math.round(n.cpu)} %`, gauge(n.cpu, { label: 'CPU' }), `charge ${n.load.map((l) => l.toFixed(2)).join(' · ')} (${n.cpus} cœur${n.cpus > 1 ? 's' : ''})`),
      meterCard('Mémoire', `${memP} %`, gauge(memP, { label: 'Mémoire' }), `${bytes(n.mem.used)} / ${bytes(n.mem.total)}`),
      meterCard('Swap', n.swap.total ? `${swapP} %` : '—', gauge(swapP, { warn: 50, bad: 80, label: 'Swap' }), n.swap.total ? `${bytes(n.swap.used)} / ${bytes(n.swap.total)}` : 'pas de swap'),
      meterCard('Disque', `${diskP} %`, gauge(diskP, { warn: 75, bad: 85, label: 'Disque' }), `${bytes(n.disk.total - n.disk.used)} libres sur ${bytes(n.disk.total)}`)),
    card('Historique', h('div', { class: 'stack-sm' },
      segmented([['24h', '24 heures'], ['7d', '7 jours']], range, (v) => { range = v; reload(); }, 'Période'),
      d.history.length ? lineChart({ labels, max: 100, unit: ' %', series: [
        { name: 'CPU', color: 'coral', values: d.history.map((p) => p.cpu) },
        { name: 'Mémoire', color: 'sky', values: d.history.map((p) => p.mem) },
        { name: 'Disque', color: 'banana', values: d.history.map((p) => p.disk) },
        { name: 'Swap', color: 'lilac', values: d.history.map((p) => p.swap) },
      ] }) : h('p', { class: 'muted' }, 'Historique en cours de constitution.'))),
    h('div', { class: 'grid grid-2' },
      card('Services', h('ul', { class: 'rows' }, n.services.filter((s) => s.present).map((s) => h('li', {},
        h('b', { class: 'grow' }, s.label || s.name), h('small', { class: 'muted' }, s.name), pill(s.active ? 'actif' : 'arrêté', s.active ? 'mint' : 'coral'))))),
      card('Certificats HTTPS', n.certs.length ? h('ul', { class: 'rows' }, n.certs.map((c) => h('li', {},
        h('b', { class: 'grow' }, c.domain), h('small', { class: 'muted' }, c.expires ? dateFr(c.expires) : '?'),
        pill(c.days === null ? '?' : `${c.days} j`, c.days === null ? 'paper' : c.days < 14 ? 'coral' : c.days < 30 ? 'banana' : 'mint'))))
        : h('p', { class: 'muted' }, 'Aucun certificat trouvé.')),
      card('Processus les plus gourmands', h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Processus', 'Mémoire', 'CPU'].map((c) => h('th', {}, c)))),
        h('tbody', {}, (n.top || []).map((p) => h('tr', {}, h('td', { class: 'ellipsis' }, p.name), h('td', {}, bytes(p.rss)), h('td', {}, `${p.cpu.toFixed(1)} %`))))))),
      card('Système', h('ul', { class: 'rows' },
        h('li', {}, h('span', { class: 'grow' }, 'En ligne depuis'), h('b', {}, duration(n.uptime))),
        h('li', {}, h('span', { class: 'grow' }, 'Système'), h('b', {}, n.os || '?')),
        h('li', {}, h('span', { class: 'grow' }, 'Réseau (depuis le démarrage)'), h('b', {}, `↓ ${bytes(n.net?.rx)} · ↑ ${bytes(n.net?.tx)}`)),
        h('li', {}, h('span', { class: 'grow' }, 'Mises à jour en attente'), h('b', {}, n.updates === null ? '?' : num(n.updates)),
          n.reboot ? pill('redémarrage requis', 'banana') : null)))));
}

const meterCard = (title, value, g, sub) => h('section', { class: 'card meter-card' }, h('div', { class: 'card-head' }, h('h2', {}, title), h('b', { class: 'big' }, value)), g, h('p', { class: 'muted small' }, sub));
