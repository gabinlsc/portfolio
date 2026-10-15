// GitHub & déploiements : derniers commits et PR, versions en ligne, historique des deploy et sauvegardes.
import { h, api, sectionHead, card, ago, bytes, pill, emptyState, num, dateTimeFr, icon } from '../lib.js';

const KIND = { '': 'deploy2 (sites)', status: 'deploy3 (status)', games: 'deploy4 (jeux)', admin: 'deploy5 (admin)' };

export async function render(root) {
  const { github: g, deploys: d } = await api('github/feed');
  root.append(sectionHead('GitHub & déploiements', g ? `GitHub mis à jour ${ago(g.at)}` : ''));
  if (!g && !d) { root.append(emptyState('Pas encore de données de la sonde (deploy5).')); return; }

  root.append(h('div', { class: 'grid grid-2' },
    card('Versions en ligne', d?.versions?.length ? h('ul', { class: 'rows' }, d.versions.map((v) => h('li', {},
      h('b', {}, v.name), h('code', {}, v.commit), h('span', { class: 'grow muted ellipsis' }, v.subject), h('small', { class: 'muted nowrap' }, ago(v.at)))))
      : h('p', { class: 'muted' }, 'Inconnues.')),
    card('Derniers déploiements', d?.backups?.length ? h('ul', { class: 'rows' }, d.backups.slice(0, 12).map((b) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, KIND[b.kind] ?? b.kind), h('small', { class: 'muted block' }, dateTimeFr(b.at))),
      h('small', { class: 'muted' }, b.size != null ? bytes(b.size) : ''))))
      : h('p', { class: 'muted' }, 'Aucune sauvegarde trouvée.'),
      { actions: d?.backups ? pill(`${num(d.backups.length)} sauvegardes · ${bytes(d.total || 0)}`, 'paper') : null }),
    card('Derniers commits', g?.commits?.length ? h('ul', { class: 'rows' }, g.commits.map((c) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, c.repo), ' ', h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.message)),
      h('small', { class: 'muted nowrap' }, ago(c.at)))))
      : h('p', { class: 'muted' }, 'Aucun commit récent.')),
    card('Activité (PR, branches…)', g?.events?.length ? h('ul', { class: 'rows' }, g.events.map((e) => h('li', {},
      pill(e.type, e.type.includes('PR') ? 'lilac' : 'sky', 'pill-sm'),
      h('span', { class: 'grow' }, h('b', {}, e.repo), ' ', e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.text) : e.text),
      h('small', { class: 'muted nowrap' }, ago(e.at)))))
      : h('p', { class: 'muted' }, 'Rien de récent.'))),
    card('Dépôts', g?.repos?.length ? h('div', { class: 'repos' }, g.repos.map((r) => h('a', { class: 'repo', href: r.url, target: '_blank', rel: 'noopener' },
      h('b', {}, r.name, r.private ? ' 🔒' : ''), h('p', { class: 'muted small clamp' }, r.description || ''),
      h('small', { class: 'muted' }, [r.language, r.stars ? `★ ${r.stars}` : null, 'push ' + ago(r.pushed)].filter(Boolean).join(' · ')))))
      : h('p', { class: 'muted' }, 'Aucun dépôt.'), { actions: h('a', { class: 'more', href: 'https://github.com/gabinlsc', target: '_blank', rel: 'noopener' }, 'GitHub', icon('external-link')) }));
}
