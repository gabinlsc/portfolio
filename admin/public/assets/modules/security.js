// Sécurité : tentatives SSH, robots qui scannent les sites, fail2ban et journal de connexion à l'admin.
import { h, api, sectionHead, card, num, bars, dateTimeFr, ago, pill, emptyState, copy, iconBtn } from '../lib.js';

export async function render(root) {
  const s = await api('security/summary');
  const head = sectionHead('Sécurité', 'Qui frappe à la porte du serveur.');
  if (!s.ready) {
    root.append(head, emptyState('Pas encore de données de la sonde (deploy5).'), adminLog(s.admin));
    return;
  }
  root.append(head,
    h('div', { class: 'kpis kpis-big' },
      h('div', { class: ['kpi-card', s.ssh.fails_24h > 100 ? 'c-coral' : 'c-banana'] }, h('b', {}, num(s.ssh.fails_24h)), h('span', {}, 'échecs SSH (24 h)')),
      h('div', { class: 'kpi-card c-peach' }, h('b', {}, num(s.ssh.fails_7d)), h('span', {}, 'échecs SSH (7 j)')),
      h('div', { class: 'kpi-card c-lilac' }, h('b', {}, num(s.scans.count_7d)), h('span', {}, 'requêtes de scanners (7 j)')),
      h('div', { class: 'kpi-card c-mint' }, h('b', {}, s.fail2ban ? num(s.fail2ban.reduce((a, j) => a + j.banned.length, 0)) : '—'), h('span', {}, 'IP bannies (fail2ban)'))),
    !s.fail2ban ? h('p', { class: 'alert alert-warn' }, 'fail2ban n’est pas installé : deploy5 propose de l’installer pour bannir automatiquement les IP qui insistent sur SSH.') : null,
    h('div', { class: 'grid grid-2' },
      card('IP qui insistent sur SSH (7 j)', ipList(s.ssh.top_ips)),
      card('Comptes essayés', bars(s.ssh.users.map((u) => ({ label: u.user || '?', value: u.n })), { color: 'peach', empty: 'Aucune tentative.' })),
      card('Chemins visés par les scanners', bars(s.scans.paths.map((p) => ({ label: p.path, value: p.n })), { color: 'lilac', empty: 'Aucun scan repéré.' })),
      card('IP des scanners', ipList(s.scans.ips)),
      card('Connexions SSH réussies', s.ssh.accepted.length ? h('ul', { class: 'rows' }, s.ssh.accepted.map((a) => h('li', {},
        h('b', {}, a.user), h('span', { class: 'mono grow' }, a.ip), h('small', { class: 'muted' }, dateTimeFr(a.ts)))))
        : h('p', { class: 'muted' }, 'Aucune connexion récente.')),
      s.fail2ban ? card('fail2ban', h('ul', { class: 'rows' }, s.fail2ban.map((j) => h('li', {},
        h('b', { class: 'grow' }, j.name), pill(`${j.banned.length} bannie${j.banned.length > 1 ? 's' : ''}`, j.banned.length ? 'coral' : 'mint'),
        h('small', { class: 'muted' }, `${num(j.total)} au total`))))) : null),
    adminLog(s.admin));
}

function ipList(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'Rien à signaler.');
  return h('ul', { class: 'rows' }, list.map((r) => h('li', {},
    h('span', { class: 'mono grow' }, r.ip),
    h('b', {}, num(r.n)), h('small', { class: 'muted nowrap' }, ago(r.last)),
    iconBtn('copy', 'Copier l’IP', () => copy(r.ip, 'IP copiée')),
    h('a', { class: 'icon-btn', href: 'https://www.abuseipdb.com/check/' + encodeURIComponent(r.ip), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Réputation de cette IP', title: 'Réputation (AbuseIPDB)' }, '?'))));
}

function adminLog(list) {
  return card('Journal de l’admin', list.length ? h('ul', { class: 'rows' }, list.map((l) => h('li', {},
    h('small', { class: 'muted nowrap' }, dateTimeFr(l.at)),
    h('span', { class: 'grow' }, l.event),
    h('span', { class: 'mono' }, l.ip),
    pill(l.event.startsWith('échec') ? 'échec' : 'ok', l.event.startsWith('échec') ? 'coral' : 'mint', 'pill-sm'))))
    : h('p', { class: 'muted' }, 'Vide.'));
}
