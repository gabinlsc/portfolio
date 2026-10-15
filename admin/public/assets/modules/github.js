// GitHub & déploiements : déploiement automatique, derniers commits et PR, versions en ligne, sauvegardes.
import { h, clear, api, attempt, sectionHead, card, ago, bytes, pill, emptyState, num, dateTimeFr, icon, btn, copy, modal } from '../lib.js';

const KIND = { '': 'deploy2 (sites)', status: 'deploy3 (status)', games: 'deploy4 (jeux)', admin: 'deploy5 (admin)' };

export async function render(root) {
  const [{ github: g, deploys: d }, dep] = await Promise.all([api('github/feed'), api('deploy/state')]);
  root.append(sectionHead('GitHub & déploiements', g ? `GitHub mis à jour ${ago(g.at)}` : ''));
  const auto = h('div', { class: 'auto-deploy' });
  root.append(auto);
  autoDeploy(auto, dep);
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

// ---------------------------------------------------------------- déploiement automatique
const STATUS = { running: ['en cours', 'banana'], ok: ['réussi', 'mint'], fail: ['raté', 'coral'], rollback: ['annulé, ancienne version remise', 'banana'] };
const secs = (n) => (n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')} s`);

function autoDeploy(box, s) {
  let timer = null;
  const refresh = async () => {
    if (!box.isConnected) return;
    try { draw(await api('deploy/state')); } catch { /* on réessaiera */ }
  };
  const draw = (st) => {
    s = st;
    clear(box, view(st, refresh));
    clearTimeout(timer);
    const busy = st.pending > 0 || st.runs.some((r) => r.status === 'running');
    timer = setTimeout(refresh, busy ? 4000 : 30000);
  };
  draw(s);
}

function view(s, refresh) {
  const select = h('select', { class: 'input', 'aria-label': 'Que déployer ?' },
    Object.entries(s.targets).map(([k, label]) => h('option', { value: k }, label)));
  const launch = btn('Déployer maintenant', async () => {
    const r = await attempt(() => api('deploy/run', { body: { target: select.value } }), (x) => x.message);
    if (r) refresh();
  }, { kind: 'primary', iconName: 'rocket' });

  const running = s.runs.find((r) => r.status === 'running');
  const runs = s.runs.length ? h('ul', { class: 'rows' }, s.runs.slice(0, 10).map((r) => {
    const [label, color] = STATUS[r.status] || [r.status, 'paper'];
    const took = secs((r.end || Math.round(Date.now() / 1000)) - r.start);
    return h('li', {},
      pill(label, color, 'pill-sm'),
      h('span', { class: 'grow' },
        h('b', {}, r.target), ' ',
        r.sha ? h('code', {}, r.sha.slice(0, 7)) : null, ' ',
        h('span', { class: 'muted' }, r.message || (r.source === 'admin' ? 'lancé depuis l’admin' : '')),
        h('small', { class: 'muted block' }, `${dateTimeFr(r.start)} · ${took}${r.step ? ' · ' + r.step : ''}`)),
      btn('Journal', () => showLog(r.id), { iconName: 'scroll-text' }));
  })) : h('p', { class: 'muted' }, 'Aucun déploiement automatique pour l’instant.');

  return card('Déploiement automatique', h('div', { class: 'stack-sm' },
    h('p', { class: 'muted small' }, 'Un push sur main d’un dépôt suivi met le serveur à jour tout seul : le portfolio (sites, status, admin ; les jeux aussi si leurs fichiers changent) ou le jeu concerné. Résultat sur Discord si l’alerte « déploiement » est active.'),
    running ? h('p', {}, pill('en cours', 'banana'), ' ', h('b', {}, running.target), running.step ? ` · ${running.step}` : '') : null,
    s.pending ? h('p', {}, pill(`${s.pending} en attente`, 'sky')) : null,
    h('div', { class: 'row' }, select, launch),
    h('h3', {}, 'Derniers déploiements'),
    runs,
    setup(s)),
  { cls: 'span-2', actions: s.configured ? pill('actif', 'mint') : pill('à configurer', 'banana') });
}

function setup(s) {
  if (!s.configured) {
    return h('p', { class: 'muted' }, 'Pas encore de secret : relance deploy5 sur le serveur pour activer le déploiement automatique.');
  }
  let shown = false;
  const secret = h('code', { class: 'ellipsis' }, '•'.repeat(24));
  const field = (label, value, ...extra) => h('div', { class: 'row' }, h('span', { class: 'nowrap' }, label), ...extra,
    btn('', () => copy(value, `${label} copié`), { iconName: 'copy', title: 'Copier' }));
  const hooks = s.hooks.length ? h('ul', { class: 'rows' }, s.hooks.slice(0, 6).map((x) => h('li', {},
    pill(x.result.startsWith('déploiement') || x.result.startsWith('ping') ? 'ok' : (x.result.startsWith('ignoré') ? 'ignoré' : 'refusé'),
      x.result.startsWith('déploiement') || x.result.startsWith('ping') ? 'mint' : (x.result.startsWith('ignoré') ? 'paper' : 'coral'), 'pill-sm'),
    h('span', { class: 'grow' }, h('b', {}, x.repo || '?'), ' ', h('span', { class: 'muted' }, `${x.event} · ${x.result}`)),
    h('small', { class: 'muted nowrap' }, ago(x.at)))))
    : h('p', { class: 'muted small' }, 'Aucun appel reçu de GitHub pour l’instant.');

  return h('details', { class: 'setup' },
    h('summary', {}, 'Configurer les webhooks GitHub'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Dans chaque dépôt (', ...s.repos.flatMap((r, i) => [i ? ', ' : '',
        h('a', { href: `https://github.com/${r}/settings/hooks/new`, target: '_blank', rel: 'noopener' }, r.split('/')[1])]),
      ') : Settings → Webhooks → Add webhook.'),
      h('li', {}, field('Payload URL', s.url, h('code', { class: 'grow ellipsis' }, s.url))),
      h('li', {}, 'Content type : ', h('code', {}, 'application/json')),
      h('li', {}, field('Secret', s.secret, secret,
        btn('', () => { shown = !shown; secret.textContent = shown ? s.secret : '•'.repeat(24); }, { iconName: 'eye', title: 'Afficher' }))),
      h('li', {}, '« Just the push event », Active, puis Add webhook. GitHub envoie un ping : il doit apparaître ci-dessous.')),
    h('h3', {}, 'Derniers appels de GitHub'),
    hooks);
}

async function showLog(id) {
  const r = await attempt(() => api(`deploy/log?id=${encodeURIComponent(id)}`));
  if (!r) return;
  const pre = h('pre', { class: 'code log' }, (r.truncated ? '… (début coupé)\n' : '') + r.text);
  modal({ title: `Journal · ${id}`, body: pre, wide: true });
  pre.scrollTop = pre.scrollHeight;
}
