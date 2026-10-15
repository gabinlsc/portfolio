// Suivi alternance : échéances (cours, devoirs) avec compte à rebours, et candidatures entreprises.
import { h, clear, api, attempt, icon, btn, iconBtn, formModal, confirmBox, sectionHead, card, pill, countdown, emptyState, segmented } from '../lib.js';

const STATUS = [['todo', 'À envoyer', 'paper'], ['sent', 'Envoyée', 'sky'], ['interview', 'Entretien', 'banana'], ['accepted', 'Acceptée', 'mint'], ['refused', 'Refusée', 'coral']];
const statusOf = (s) => STATUS.find((x) => x[0] === s) || STATUS[0];
let showDone = false;

export async function render(root) {
  const data = await api('school/list');
  const deadlinesBox = h('div', {});
  const appsBox = h('div', {});
  root.append(sectionHead('Alternance', 'Ce qu’il y a à rendre, et où tu en es avec les entreprises.'), h('div', { class: 'grid grid-2' }, deadlinesBox, appsBox));

  let last = data;
  const set = (d = last) => {
    last = d;
    clear(deadlinesBox, deadlinesCard(d.deadlines, set));
    clear(appsBox, appsCard(d.applications, set));
  };
  set(data);
}

function deadlinesCard(list, set) {
  const visible = list.filter((d) => showDone || !d.done);
  const body = h('div', { class: 'stack-sm' },
    segmented([[false, 'À faire'], [true, 'Tout']], showDone, (v) => { showDone = v; set(); }, 'Filtre'),
    visible.length ? h('ul', { class: 'rows' }, visible.map((d) => {
      const c = countdown(d.due);
      return h('li', { class: d.done ? 'done' : null },
        h('input', { type: 'checkbox', checked: !!d.done, 'aria-label': `Marquer « ${d.title} » comme fait`, onchange: async () => {
          const r = await attempt(() => api('school/deadline-toggle', { body: { id: d.id } }));
          if (r) set(r);
        } }),
        h('span', { class: 'grow' }, h('b', {}, d.title), d.course ? h('small', { class: 'muted' }, ' · ' + d.course) : null,
          h('small', { class: 'muted block' }, new Date(d.due.length === 10 ? d.due + 'T12:00' : d.due).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: d.due.length > 10 ? '2-digit' : undefined, minute: d.due.length > 10 ? '2-digit' : undefined }))),
        d.done ? pill('fait', 'mint') : pill(c.text, c.kind === 'bad' ? 'coral' : c.kind === 'warn' ? 'banana' : 'paper'),
        iconBtn('pencil', 'Modifier', () => deadlineForm(d, set)),
        iconBtn('trash-2', 'Supprimer', async () => {
          if (!(await confirmBox(`Supprimer « ${d.title} » ?`))) return;
          const r = await attempt(() => api('school/deadline-delete', { body: { id: d.id } }));
          if (r) set(r);
        }));
    })) : emptyState(showDone ? 'Aucune échéance.' : 'Rien à rendre 🎉'));
  return card('Échéances', body, { actions: btn('Échéance', () => deadlineForm(null, set), { iconName: 'plus' }) });
}

function appsCard(list, set) {
  const counts = Object.fromEntries(STATUS.map(([k]) => [k, list.filter((a) => a.status === k).length]));
  const body = h('div', { class: 'stack-sm' },
    h('div', { class: 'pills' }, STATUS.map(([k, label, color]) => pill(`${label} : ${counts[k]}`, color))),
    list.length ? h('ul', { class: 'rows' }, list.map((a) => {
      const [, label, color] = statusOf(a.status);
      return h('li', {},
        h('span', { class: 'grow' }, h('b', {}, a.company), a.role ? h('small', { class: 'muted' }, ' · ' + a.role) : null,
          a.applied_on ? h('small', { class: 'muted block' }, 'Le ' + new Date(a.applied_on + 'T12:00').toLocaleDateString('fr-FR')) : null),
        a.link ? h('a', { class: 'icon-btn', href: a.link, target: '_blank', rel: 'noopener', 'aria-label': 'Annonce' }, icon('external-link')) : null,
        pill(label, color),
        iconBtn('pencil', 'Modifier', () => appForm(a, set)),
        iconBtn('trash-2', 'Supprimer', async () => {
          if (!(await confirmBox(`Supprimer la candidature ${a.company} ?`))) return;
          const r = await attempt(() => api('school/app-delete', { body: { id: a.id } }));
          if (r) set(r);
        }));
    })) : emptyState('Aucune candidature suivie.'));
  return card('Candidatures', body, { actions: btn('Candidature', () => appForm(null, set), { iconName: 'plus' }) });
}

function deadlineForm(d, set) {
  formModal({
    title: d ? 'Modifier l’échéance' : 'Nouvelle échéance',
    fields: [
      { name: 'title', label: 'Quoi ?', value: d?.title, required: true, max: 120, placeholder: 'Projet PHP, partiel réseau…' },
      { name: 'course', label: 'Matière', value: d?.course, max: 60 },
      { name: 'due', label: 'Pour quand ?', type: 'datetime-local', value: d?.due?.length === 10 ? d.due + 'T23:59' : d?.due, required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', value: d?.notes, rows: 3 },
    ],
    onSubmit: async (v) => set(await api('school/deadline-save', { body: { id: d?.id, ...v } })),
  });
}

function appForm(a, set) {
  formModal({
    title: a ? 'Modifier la candidature' : 'Nouvelle candidature',
    fields: [
      { name: 'company', label: 'Entreprise', value: a?.company, required: true, max: 80 },
      { name: 'role', label: 'Poste', value: a?.role, max: 80 },
      { name: 'status', label: 'Statut', type: 'select', options: STATUS.map(([k, l]) => [k, l]), value: a?.status || 'todo' },
      { name: 'applied_on', label: 'Date d’envoi', type: 'date', value: a?.applied_on },
      { name: 'link', label: 'Lien de l’annonce', type: 'url', value: a?.link, placeholder: 'https://…' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: a?.notes, rows: 3 },
    ],
    onSubmit: async (v) => set(await api('school/app-save', { body: { id: a?.id, ...v } })),
  });
}
