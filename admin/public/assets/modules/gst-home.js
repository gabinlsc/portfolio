// Accueil de l'espace StudioGLSC : ce qui demande une action (demandes, factures, déclarations) et le chiffre d'affaires de l'année.
import { h, api, icon, card, pill, columns, gauge, ago, sectionHead } from '../lib.js';

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = (cents) => fmt.format((cents || 0) / 100);
const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
const dateLong = (iso) => new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export async function render(root) {
  const d = await api('gst/home');
  const hello = new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir';
  const s = d.studio;

  const todo = (href, ic, text, count, warn) => h('a', { class: ['gst-todo', warn && 'warn'], href }, icon(ic), h('span', {}, text), h('b', {}, String(count)));
  const todos = [];
  if (s.new_requests) todos.push(todo('#/studio', 'briefcase', s.new_requests > 1 ? 'Nouvelles demandes de devis' : 'Nouvelle demande de devis', s.new_requests));
  if (s.unread) todos.push(todo('#/studio', 'users', 'Messages clients non lus', s.unread));
  if (d.unpaid.overdue) todos.push(todo('#/accounting', 'circle-alert', 'Factures en retard de paiement', d.unpaid.overdue, true));
  else if (d.unpaid.count) todos.push(todo('#/billing', 'file-text', `Factures en attente de paiement (${eur(d.unpaid.total)})`, d.unpaid.count));
  if (d.drafts) todos.push(todo('#/billing', 'file-text', 'Brouillons à finaliser', d.drafts));
  if (d.to_declare) todos.push(todo('#/accounting', 'wallet', 'Déclarations de cotisations à faire', d.to_declare, true));
  if (d.seller_missing.length) todos.push(todo('#/billing', 'circle-alert', `À renseigner avant de facturer : ${d.seller_missing.join(', ')}`, d.seller_missing.length, true));

  const next = d.next_declaration;
  const ceilPct = d.ceiling ? Math.min(100, Math.round((100 * d.revenue) / d.ceiling)) : 0;
  const months = d.months.map((v, i) => ({ label: MONTHS[i], value: Math.round(v / 100) }));

  root.append(h('div', { class: 'stack' },
    h('div', { class: 'gst-hero' },
      h('div', {}, h('h1', {}, `${hello} Gabin`), h('p', {}, 'Votre activité StudioGLSC : demandes, devis, factures et compta.')),
      h('a', { class: 'btn', href: '#/billing' }, icon('file-text'), h('span', {}, 'Devis & factures'))),
    d.test_mode ? card('Mode test activé', h('p', {}, 'Les documents créés maintenant portent la série TEST- et ne comptent pas dans la compta.'), { color: 'peach' }) : null,
    s.down ? card('Service des demandes indisponible', h('p', {}, s.down), { color: 'coral' }) : null,
    h('div', { class: 'grid grid-2' },
      card('À faire', todos.length ? h('div', { class: 'stack-xs' }, todos) : h('p', { class: 'muted' }, 'Rien d’urgent. Tout est à jour.')),
      card('Demandes à traiter', s.requests.length
        ? h('ul', { class: 'rows' }, s.requests.map((r) => h('li', {}, h('b', { class: 'grow ellipsis' }, r.name), pill(r.service || 'Demande', 'paper', 'pill-sm'), h('small', { class: 'muted nowrap' }, ago(r.at)))))
        : h('p', { class: 'muted' }, s.down ? '—' : 'Aucune nouvelle demande.'),
      { actions: [h('a', { class: 'more', href: '#/studio' }, 'Tout voir', icon('arrow-right'))] })),
    h('div', { class: 'grid grid-3' },
      card(`CA encaissé ${d.year}`, h('div', { class: 'stack-xs' }, h('div', { class: 'big' }, eur(d.revenue)), gauge(ceilPct, { warn: 70, bad: 90, label: `${ceilPct} % du plafond micro (${eur(d.ceiling)})` }),
        h('p', { class: 'hint' }, `Franchise de TVA jusqu’à ${eur(d.vat_base)}.`))),
      card('Revenu net estimé', h('div', { class: 'stack-xs' }, h('div', { class: 'big' }, eur(d.net)), h('p', { class: 'hint' }, `Après ${eur(d.contributions)} de cotisations estimées et les dépenses saisies.`))),
      card('Devis en cours', h('div', { class: 'stack-xs' }, h('div', { class: 'big' }, String(d.quotes_open.count)), h('p', { class: 'hint' }, `${eur(d.quotes_open.total)} en attente de réponse.`)))),
    h('div', { class: 'grid grid-2' },
      card('Encaissements par mois', columns(months, { color: 'sky', unit: ' €' })),
      card('Prochaine déclaration', next
        ? h('div', { class: 'stack-xs' }, h('p', {}, h('b', {}, next.label), ` — avant le ${dateLong(next.due)}`), h('p', { class: 'hint' }, `CA de la période : ${eur(next.revenue)} · cotisations estimées : ${eur(next.contribution)}.`),
          h('a', { class: 'more', href: '#/accounting' }, 'Ouvrir la compta', icon('arrow-right')))
        : h('p', { class: 'muted' }, 'Aucune échéance à venir.')))));
}
