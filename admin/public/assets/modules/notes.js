// Bloc-notes (post-it colorés, épinglables) et liens rapides affichés sur l'accueil.
import { h, clear, api, attempt, icon, btn, iconBtn, formModal, confirmBox, sectionHead, card, emptyState, ago, copy } from '../lib.js';

export async function render(root) {
  const [{ notes }, { links }] = await Promise.all([api('notes/list'), api('links/list')]);
  const notesBox = h('div', {});
  const linksBox = h('div', {});
  root.append(
    sectionHead('Notes & liens', 'Pense-bêtes, idées, commandes à garder sous la main.', btn('Note', () => noteForm(null, setNotes), { kind: 'primary', iconName: 'plus' })),
    notesBox,
    linksBox);

  function setNotes(list) {
    clear(notesBox, list.length ? h('div', { class: 'notes' }, list.map((n) => noteEl(n, setNotes))) : emptyState('Aucune note pour l’instant.'));
  }
  function setLinks(list) {
    clear(linksBox, card('Liens rapides', h('div', { class: 'stack-sm' },
      h('p', { class: 'muted small' }, 'Ils apparaissent en haut de l’accueil.'),
      list.length ? h('ul', { class: 'rows' }, list.map((l) => h('li', {},
        h('a', { class: ['sticker', `c-${l.color}`], href: l.url, target: '_blank', rel: 'noopener' }, l.label),
        h('span', { class: 'muted grow ellipsis' }, l.url),
        iconBtn('pencil', `Modifier ${l.label}`, () => linkForm(l, setLinks)),
        iconBtn('trash-2', `Supprimer ${l.label}`, async () => {
          if (!(await confirmBox(`Supprimer le lien « ${l.label} » ?`))) return;
          const r = await attempt(() => api('links/delete', { body: { id: l.id } }));
          if (r) setLinks(r.links);
        })))) : null),
      { actions: btn('Lien', () => linkForm(null, setLinks), { iconName: 'plus' }) }));
  }
  setNotes(notes);
  setLinks(links);
}

function noteEl(n, setNotes) {
  return h('article', { class: ['note', `c-${n.color}`, n.pinned && 'pinned'] },
    h('header', {},
      h('h2', {}, n.pinned ? icon('pin') : null, n.title || 'Sans titre'),
      h('div', { class: 'note-actions' },
        iconBtn('copy', 'Copier le texte', () => copy(n.body, 'Note copiée')),
        iconBtn('pencil', 'Modifier', () => noteForm(n, setNotes)),
        iconBtn('trash-2', 'Supprimer', async () => {
          if (!(await confirmBox(`Supprimer la note « ${n.title || 'sans titre'} » ?`))) return;
          const r = await attempt(() => api('notes/delete', { body: { id: n.id } }));
          if (r) setNotes(r.notes);
        }))),
    h('p', { class: 'note-body' }, n.body),
    h('small', { class: 'muted' }, 'Modifiée ' + ago(n.updated)));
}

function noteForm(n, setNotes) {
  formModal({
    title: n ? 'Modifier la note' : 'Nouvelle note',
    fields: [
      { name: 'title', label: 'Titre', value: n?.title, max: 120 },
      { name: 'body', label: 'Texte', type: 'textarea', value: n?.body, rows: 9 },
      { name: 'color', label: 'Couleur', type: 'colors', value: n?.color || 'banana' },
      { name: 'pinned', label: 'Épingler en haut', type: 'checkbox', value: n?.pinned },
    ],
    onSubmit: async (v) => setNotes((await api('notes/save', { body: { id: n?.id, ...v } })).notes),
  });
}

function linkForm(l, setLinks) {
  formModal({
    title: l ? 'Modifier le lien' : 'Nouveau lien rapide',
    fields: [
      { name: 'label', label: 'Nom', value: l?.label, required: true, max: 40 },
      { name: 'url', label: 'Adresse', type: 'url', value: l?.url, required: true, placeholder: 'https://…' },
      { name: 'color', label: 'Couleur', type: 'colors', value: l?.color || 'sky' },
    ],
    onSubmit: async (v) => setLinks((await api('links/save', { body: { id: l?.id, ...v } })).links),
  });
}
