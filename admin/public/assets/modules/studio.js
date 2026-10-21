// StudioGLSC : demandes de devis, projets clients (suivi privé) et visites de studio.glsc.fr.
// Les données viennent du service « studio » ; tout le texte venant d'un visiteur ou d'un client est inséré comme texte (jamais en HTML).
import { h, api, attempt, toast, modal, confirmBox, formModal, sectionHead, card, num, pill, ago, dateFr, dateTimeFr, bytes, bars, lineChart, emptyState, btn, copy, segmented } from '../lib.js';

const STATUS = [['new', 'Nouveau', 'banana'], ['contacted', 'Contacté', 'sky'], ['quote', 'Devis envoyé', 'lilac'], ['won', 'Gagné', 'mint'], ['lost', 'Perdu', 'paper']];
const STATUS_LABEL = Object.fromEntries(STATUS.map(([k, l]) => [k, l]));
const STATUS_COLOR = Object.fromEntries(STATUS.map(([k, , c]) => [k, c]));
const PROJECT_LABEL = { active: 'En cours', done: 'Terminé', archived: 'Archivé' };

export async function render(root) {
  const state = { tab: 'requests', filter: 'open', data: null };
  const box = h('div', {});
  root.append(box);
  const load = async () => {
    state.data = await api('studio/overview');
    draw();
  };
  const draw = () => box.replaceChildren(view(state, load, draw));
  await load();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected && !document.querySelector('.overlay')) load().catch(() => {}); }, 60000);
  return () => clearInterval(timer);
}

function view(state, load, draw) {
  const d = state.data;
  const fresh = d.requests.filter((r) => r.status === 'new').length;
  const unread = d.projects.reduce((a, p) => a + (p.unread || 0), 0);
  const tabs = segmented([['requests', `Demandes${fresh ? ` (${fresh})` : ''}`], ['projects', `Projets${unread ? ` (${unread})` : ''}`], ['visits', 'Visites']], state.tab, (v) => { state.tab = v; draw(); }, 'Section');
  const head = sectionHead('StudioGLSC', 'Les demandes reçues sur studio.glsc.fr, les projets en cours et les visites.', tabs);
  const down = d.down ? card('Service indisponible', h('p', {}, d.down), { color: 'coral' }) : null;
  const body = state.tab === 'requests' ? requestsView(state, load, draw) : state.tab === 'projects' ? projectsView(state, load) : visitsView(d.stats);
  return h('div', { class: 'stack' }, head, down, body);
}

// ---------------------------------------------------------------- demandes
function requestsView(state, load, draw) {
  const d = state.data;
  const open = (r) => r.status === 'new' || r.status === 'contacted' || r.status === 'quote';
  const shown = d.requests.filter((r) => state.filter === 'all' || (state.filter === 'open' ? open(r) : r.status === state.filter));
  const filter = segmented([['open', 'En cours'], ['all', 'Toutes'], ['won', 'Gagnées'], ['lost', 'Perdues']], state.filter, (v) => { state.filter = v; draw(); }, 'Filtrer');
  const list = shown.length
    ? shown.map((r) => requestCard(r, load))
    : [emptyState(d.requests.length ? 'Aucune demande dans ce filtre.' : 'Aucune demande pour l’instant. Elles apparaissent ici dès que le formulaire de studio.glsc.fr est relié au service.')];
  return h('div', { class: 'stack' }, h('div', { class: 'row-between' }, filter,
    h('small', { class: 'muted' }, `Conservées ${d.retentionDays} jours, puis supprimées automatiquement.`)), ...list);
}

function requestCard(r, load) {
  const note = h('textarea', { class: 'input', rows: 2, placeholder: 'Notes privées (devis envoyé, rappel prévu…)', 'aria-label': 'Notes' }, r.note || '');
  const save = (patch, msg) => attempt(() => api('studio/request', { body: { id: r.id, ...patch } }), msg).then((x) => x && load());
  const statusButtons = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Statut' }, STATUS.map(([k, label]) =>
    h('button', { type: 'button', class: ['seg', r.status === k && 'active'], 'aria-pressed': String(r.status === k), onclick: () => r.status !== k && save({ status: k }) }, label)));
  return card(null, h('div', { class: 'stack-sm' },
    h('div', { class: 'row-between' },
      h('div', {}, h('b', {}, r.name), ' ', pill(STATUS_LABEL[r.status] || r.status, STATUS_COLOR[r.status] || 'paper', 'pill-sm'), ' ', h('small', { class: 'muted' }, `${ago(r.at)} · ${dateTimeFr(r.at)}`)),
      h('div', {}, pill(r.service, 'peach', 'pill-sm'), ' ', pill(r.activity, 'paper', 'pill-sm'), ' ', pill(r.timing, 'mint', 'pill-sm'))),
    h('p', {}, h('a', { href: `mailto:${r.email}?subject=${encodeURIComponent('Votre demande StudioGLSC')}` }, r.email),
      r.phone ? [' · ', h('a', { href: `tel:${r.phone.replace(/[^\d+]/g, '')}` }, r.phone)] : null),
    r.message ? h('p', { class: 'pre-wrap' }, r.message) : h('p', { class: 'muted' }, 'Pas de message.'),
    statusButtons, note,
    h('div', { class: 'btn-row' },
      btn('Enregistrer la note', () => save({ note: note.value }, 'Note enregistrée'), { iconName: 'save' }),
      btn('Supprimer', async () => { if (await confirmBox(`Supprimer définitivement la demande de ${r.name} ?`)) attempt(() => api('studio/request/delete', { body: { id: r.id } }), 'Demande supprimée').then((x) => x && load()); }, { kind: 'danger', iconName: 'trash-2' }))));
}

// ---------------------------------------------------------------- projets clients
function projectsView(state, load) {
  const d = state.data;
  const add = btn('Nouveau projet', () => formModal({
    title: 'Nouveau projet client', submit: 'Créer et obtenir le lien',
    fields: [{ name: 'title', label: 'Titre du projet', required: true, placeholder: 'Site vitrine', max: 80 }, { name: 'client', label: 'Client', required: true, placeholder: 'Boulangerie Le Fournil', max: 80 }],
    onSubmit: async (v) => { const r = await api('studio/project/create', { body: v }); await load(); showLink(r.link, 'Le lien de suivi a été créé'); },
  }), { kind: 'primary', iconName: 'plus' });
  const list = d.projects.length ? d.projects.map((p) => projectCard(p, load)) : [emptyState('Aucun projet. Crée-en un pour donner à un client un lien privé où suivre l’avancement, t’écrire et déposer ses contenus.')];
  return h('div', { class: 'stack' }, h('div', { class: 'row-between' },
    h('p', { class: 'muted' }, 'Le client n’a pas de compte : il reçoit un lien secret (dans le fragment de l’adresse, donc jamais enregistré dans les journaux du serveur).'), add), ...list);
}

function showLink(link, title) {
  const input = h('input', { class: 'input', readonly: true, value: link, 'aria-label': 'Lien de suivi' });
  modal({
    title, body: h('div', { class: 'stack' },
      h('p', {}, 'Envoie ce lien au client. Il n’est affiché qu’une fois : si tu le perds, génère-en un nouveau (l’ancien cessera de fonctionner).'),
      input, h('div', { class: 'btn-row' }, btn('Copier le lien', () => copy(link, 'Lien copié'), { kind: 'primary', iconName: 'copy' }))),
  });
  setTimeout(() => input.select(), 50);
}

function projectCard(p, load) {
  const done = p.status === 'done' ? p.steps.length : p.current;
  const meter = h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.steps.length, 'aria-valuenow': done }, h('div', { class: 'meter-fill', style: { width: `${p.steps.length ? (done / p.steps.length) * 100 : 0}%` } }));
  return card(null, h('div', { class: 'stack-sm' },
    h('div', { class: 'row-between' },
      h('div', {}, h('b', {}, p.title), ' ', h('span', { class: 'muted' }, `· ${p.client}`), ' ', pill(PROJECT_LABEL[p.status] || p.status, p.status === 'active' ? 'sky' : 'paper', 'pill-sm'),
        p.unread ? [' ', pill(`${p.unread} nouveau${p.unread > 1 ? 'x' : ''}`, 'coral', 'pill-sm')] : null),
      btn('Ouvrir', () => openProject(p.id, load), { kind: 'primary', iconName: 'folder-open' })),
    meter,
    h('small', { class: 'muted' }, `${p.steps[Math.min(p.current, p.steps.length - 1)] || ''} · ${p.messages.length} message${p.messages.length > 1 ? 's' : ''} · ${p.files.length} fichier${p.files.length > 1 ? 's' : ''} · créé le ${dateFr(p.createdAt)}`)));
}

async function openProject(id, load) {
  const mk = async () => (await api('studio/overview')).projects.find((x) => x.id === id);
  let p = await mk();
  if (!p) return;
  const body = h('div', { class: 'stack' });
  const refresh = async () => { p = await mk(); if (!p) { close(); return; } paint(); load(); };
  const act = (path, payload, msg) => attempt(() => api(path, { body: { id, ...payload } }), msg).then((r) => r && refresh());
  function paint() {
    const steps = h('ol', { class: 'steps-admin' }, p.steps.map((label, i) => {
      const state = p.status === 'done' || i < p.current ? 'done' : i === p.current ? 'current' : 'todo';
      return h('li', {}, h('button', { type: 'button', class: ['step-btn', state], title: 'Mettre le projet à cette étape', onclick: () => act('studio/project/update', { current: i }) }, label));
    }));
    const thread = h('div', { class: 'thread' }, p.messages.length ? p.messages.map((m) => h('div', { class: ['bubble', m.from] },
      h('small', { class: 'muted' }, `${m.from === 'client' ? 'Client' : 'Toi'} · ${dateTimeFr(m.at)}`), h('p', { class: 'pre-wrap' }, m.text))) : h('p', { class: 'muted' }, 'Aucun message pour l’instant.'));
    const reply = h('textarea', { class: 'input', rows: 3, placeholder: 'Écrire au client (il le verra sur sa page de suivi)…', 'aria-label': 'Message au client' });
    const files = p.files.length ? h('ul', { class: 'rows' }, p.files.map((f) => h('li', {},
      h('span', { class: 'grow' }, h('a', { href: `/api/studio/file?project=${p.id}&file=${f.id}`, download: f.name }, f.name), ' ', h('small', { class: 'muted' }, `${bytes(f.size)} · ${dateTimeFr(f.at)}`)),
      btn('', async () => { if (await confirmBox(`Supprimer le fichier « ${f.name} » ?`)) act('studio/project/file/delete', { file: f.id }, 'Fichier supprimé'); }, { kind: 'ghost', iconName: 'trash-2', title: 'Supprimer' })))) : h('p', { class: 'muted' }, 'Aucun fichier déposé.');
    body.replaceChildren(
      h('div', { class: 'row-between' }, h('p', {}, h('b', {}, p.client), ` · créé le ${dateFr(p.createdAt)}`),
        segmented([['active', 'En cours'], ['done', 'Terminé'], ['archived', 'Archivé']], p.status, (v) => act('studio/project/update', { status: v }), 'Statut du projet')),
      h('h3', {}, 'Avancement'), steps,
      h('h3', {}, 'Messages'), thread, reply,
      h('div', { class: 'btn-row' }, btn('Envoyer', () => { if (reply.value.trim()) act('studio/project/message', { text: reply.value }, 'Message envoyé'); }, { kind: 'primary', iconName: 'send' }),
        p.unread ? btn('Marquer comme lu', () => act('studio/project/update', { read: true })) : null),
      h('h3', {}, 'Fichiers du client'), files,
      h('h3', {}, 'Lien et suppression'),
      h('div', { class: 'btn-row' },
        btn('Nouveau lien de suivi', async () => { if (await confirmBox('L’ancien lien cessera de fonctionner. Continuer ?', { ok: 'Générer', danger: false })) { const r = await attempt(() => api('studio/project/link', { body: { id } })); if (r) showLink(r.link, 'Nouveau lien de suivi'); } }, { iconName: 'link' }),
        btn('Supprimer le projet', async () => { if (await confirmBox(`Supprimer « ${p.title} » avec ses messages et ses fichiers ? C’est définitif.`)) { const r = await attempt(() => api('studio/project/delete', { body: { id } }), 'Projet supprimé'); if (r) { close(); load(); } } }, { kind: 'danger', iconName: 'trash-2' })));
    if (p.unread) attempt(() => api('studio/project/update', { body: { id, read: true } })).then(() => { p.unread = 0; });
  }
  paint();
  const close = modal({ title: p.title, body, wide: true, onClose: () => load() });
}

// ---------------------------------------------------------------- visites (journaux nginx, sans cookie)
function visitsView(s) {
  if (!s) return emptyState('Pas encore de statistiques : la sonde les calcule à partir des journaux du serveur, elles apparaissent après quelques visites.');
  const t = s.totals;
  const kpi = (v, l, c) => h('div', { class: ['kpi-tile', `c-${c}`] }, h('b', {}, v), h('span', {}, l));
  const days = s.daily.map((x) => new Date(x.day + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
  return h('div', { class: 'stack' },
    h('div', { class: 'kpi-grid' }, kpi(num(t.visitors7), 'visiteurs (7 jours)', 'banana'), kpi(num(t.visitors30), 'visiteurs (30 jours)', 'mint'),
      kpi(num(t.views30), 'pages vues (30 jours)', 'sky'), kpi(num(t.quotes30), 'demandes de devis (30 jours)', t.quotes30 ? 'lilac' : 'paper'),
      kpi(t.rate30 == null ? '–' : `${String(t.rate30).replace('.', ',')} %`, 'visiteurs qui demandent un devis', 'peach')),
    h('p', { class: 'muted small' }, 'Mesuré dans les journaux du serveur : aucun cookie ni script de suivi. Un visiteur = une adresse et un navigateur sur une journée, donc un chiffre approximatif.'),
    h('div', { class: 'grid grid-2' },
      card('Visites par jour (30 jours)', lineChart({ labels: days, series: [{ name: 'Visiteurs', color: 'banana', values: s.daily.map((x) => x.visitors) }, { name: 'Pages vues', color: 'sky', values: s.daily.map((x) => x.views) }] }), { cls: 'span-2' }),
      card('Rubriques', bars(s.sections.map((x) => ({ label: x.label, value: x.views })), { color: 'mint', empty: 'Aucune visite.' })),
      card('D’où viennent les visiteurs', bars(s.sources.map((x) => ({ label: x.label, value: x.views })), { color: 'lilac', empty: 'Aucune source.' })),
      card('Pages les plus vues', bars(s.pages.map((x) => ({ label: x.path, value: x.views })), { color: 'sky', empty: 'Aucune page.' })),
      card('Appareils', bars(s.devices.map((x) => ({ label: x.label, value: x.views })), { color: 'peach', empty: 'Aucun appareil.' }))));
}
