// Kanban : plusieurs tableaux, colonnes colorées, cartes déplaçables (glisser-déposer ou menu « Colonne » sur mobile).
import { h, clear, api, attempt, icon, btn, iconBtn, formModal, confirmBox, pill, countdown, sectionHead, COLORS } from '../lib.js';

let state = { boards: [], board: null };
const KEY = 'glsc-admin-board';

export async function render(root) {
  const { boards } = await api('kanban/boards');
  state.boards = boards;
  let id = Number(localStorage.getItem(KEY)) || boards[0]?.id;
  if (!boards.some((b) => b.id === id)) id = boards[0]?.id;
  state.board = (await api('kanban/board?id=' + id)).board;
  draw(root);
}

function draw(root) {
  const b = state.board;
  const select = h('select', { class: 'input input-sm', 'aria-label': 'Tableau', onchange: async (e) => {
    const r = await attempt(() => api('kanban/board?id=' + e.target.value));
    if (r) { state.board = r.board; localStorage.setItem(KEY, r.board.id); draw(root); }
  } }, state.boards.map((x) => h('option', { value: x.id, selected: x.id === b.id || null }, x.name)));

  clear(root,
    sectionHead('Kanban', 'Glisse les cartes d’une colonne à l’autre. Sur téléphone, ouvre une carte pour la changer de colonne.',
      select,
      iconBtn('pencil', 'Renommer le tableau', () => boardForm(root, b)),
      iconBtn('trash-2', 'Supprimer le tableau', async () => {
        if (!(await confirmBox(`Supprimer le tableau « ${b.name} » et toutes ses cartes ?`))) return;
        if (await attempt(() => api('kanban/board-delete', { body: { id: b.id } }), 'Tableau supprimé')) render(root);
      }),
      btn('Tableau', () => boardForm(root), { iconName: 'plus' })),
    h('div', { class: 'board' },
      b.columns.map((c) => column(root, c)),
      h('button', { class: 'add-col', type: 'button', onclick: () => columnForm(root) }, icon('plus'), 'Colonne')));
}

function setBoard(root, board) {
  state.board = board;
  const entry = state.boards.find((x) => x.id === board.id);
  if (entry) entry.name = board.name;
  draw(root);
}

function column(root, c) {
  const list = h('div', { class: 'col-cards', dataset: { col: c.id } }, c.cards.map((card) => cardEl(root, c, card)));
  dropZone(root, list, c);
  return h('section', { class: ['kcol', `c-${c.color}`], 'aria-label': c.name },
    h('header', { class: 'kcol-head' },
      h('h2', {}, c.name), h('span', { class: 'count' }, c.cards.length),
      iconBtn('ellipsis', `Modifier la colonne ${c.name}`, () => columnForm(root, c))),
    list,
    h('button', { class: 'add-card', type: 'button', onclick: () => cardForm(root, null, c.id) }, icon('plus'), 'Ajouter une carte'));
}

function cardEl(root, col, c) {
  const due = c.due ? countdown(c.due) : null;
  const el = h('article', { class: 'kcard', draggable: 'true', tabindex: '0', dataset: { id: c.id }, 'aria-label': c.title,
    onclick: () => cardForm(root, c, col.id),
    onkeydown: (e) => { if (e.key === 'Enter') cardForm(root, c, col.id); } },
    c.label ? pill(c.label, 'lilac', 'pill-sm') : null,
    h('h3', {}, c.title),
    c.body ? h('p', { class: 'muted small clamp' }, c.body) : null,
    due ? h('p', { class: ['due', `due-${due.kind}`] }, icon('calendar'), due.text) : null);
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(c.id));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

function dropZone(root, list, col) {
  const marker = h('div', { class: 'drop-marker' });
  const after = (y) => [...list.querySelectorAll('.kcard:not(.dragging)')].find((el) => y < el.getBoundingClientRect().top + el.offsetHeight / 2);
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const next = after(e.clientY);
    if (next) list.insertBefore(marker, next); else list.appendChild(marker);
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) marker.remove(); });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const ids = [];
    for (const node of list.children) {
      if (node === marker) ids.push(id);
      else if (node.dataset.id && Number(node.dataset.id) !== id) ids.push(Number(node.dataset.id));
    }
    if (!ids.includes(id)) ids.push(id);
    marker.remove();
    const r = await attempt(() => api('kanban/card-move', { body: { id, column_id: col.id, ids } }));
    if (r) setBoard(root, r.board);
  });
}

function cardForm(root, c, columnId) {
  const cols = state.board.columns.map((x) => [x.id, x.name]);
  const del = c ? btn('Supprimer', async () => {
    if (!(await confirmBox(`Supprimer « ${c.title} » ?`))) return;
    const r = await attempt(() => api('kanban/card-delete', { body: { id: c.id } }), 'Carte supprimée');
    if (r) { document.querySelector('.overlay')?.remove(); setBoard(root, r.board); }
  }, { kind: 'danger', iconName: 'trash-2' }) : null;
  formModal({
    title: c ? 'Modifier la carte' : 'Nouvelle carte',
    fields: [
      { name: 'title', label: 'Titre', value: c?.title, required: true, max: 200 },
      { name: 'body', label: 'Détails', type: 'textarea', value: c?.body, rows: 5 },
      { name: 'label', label: 'Étiquette', value: c?.label, placeholder: 'urgent, cours, perso…', max: 30 },
      { name: 'due', label: 'Échéance', type: 'date', value: c?.due?.slice(0, 10) },
      { name: 'column_id', label: 'Colonne', type: 'select', options: cols, value: columnId },
    ],
    extra: del ? [h('div', { class: 'row-end' }, del)] : [],
    onSubmit: async (v) => {
      const target = Number(v.column_id);
      let r = await api('kanban/card-save', { body: { id: c?.id, column_id: target, title: v.title, body: v.body, label: v.label, due: v.due } });
      if (c && target !== columnId) {
        const ids = r.board.columns.find((x) => x.id === target).cards.map((x) => x.id).filter((x) => x !== c.id).concat(c.id);
        r = await api('kanban/card-move', { body: { id: c.id, column_id: target, ids } });
      }
      setBoard(root, r.board);
    },
  });
}

function columnForm(root, c) {
  const del = c ? btn('Supprimer la colonne', async () => {
    if (!(await confirmBox(`Supprimer « ${c.name} » et ses ${c.cards.length} carte(s) ?`))) return;
    const r = await attempt(() => api('kanban/column-delete', { body: { id: c.id } }), 'Colonne supprimée');
    if (r) { document.querySelector('.overlay')?.remove(); setBoard(root, r.board); }
  }, { kind: 'danger', iconName: 'trash-2' }) : null;
  const order = c ? h('div', { class: 'row' },
    btn('Vers la gauche', () => move(root, c, -1), { iconName: 'arrow-left' }),
    btn('Vers la droite', () => move(root, c, 1), { iconName: 'arrow-right' })) : null;
  formModal({
    title: c ? 'Modifier la colonne' : 'Nouvelle colonne',
    fields: [
      { name: 'name', label: 'Nom', value: c?.name, required: true, max: 40 },
      { name: 'color', label: 'Couleur', type: 'colors', value: c?.color || COLORS[1] },
    ],
    extra: [order, del ? h('div', { class: 'row-end' }, del) : null],
    onSubmit: async (v) => {
      const r = await api('kanban/column-save', { body: { id: c?.id, board_id: state.board.id, name: v.name, color: v.color } });
      setBoard(root, r.board);
    },
  });
}

async function move(root, c, dir) {
  const ids = state.board.columns.map((x) => x.id);
  const i = ids.indexOf(c.id), j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const r = await attempt(() => api('kanban/column-order', { body: { board_id: state.board.id, ids } }));
  if (r) { document.querySelector('.overlay')?.remove(); setBoard(root, r.board); }
}

function boardForm(root, b) {
  formModal({
    title: b ? 'Renommer le tableau' : 'Nouveau tableau',
    fields: [{ name: 'name', label: 'Nom', value: b?.name, required: true, max: 60 }],
    onSubmit: async (v) => {
      const r = await api('kanban/board-save', { body: { id: b?.id, name: v.name } });
      if (!b) { state.boards.push({ id: r.board.id, name: r.board.name }); localStorage.setItem(KEY, r.board.id); }
      setBoard(root, r.board);
    },
  });
}
