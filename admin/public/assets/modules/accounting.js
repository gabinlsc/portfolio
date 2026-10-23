// Compta de la micro-entreprise : tableau de bord, livre des recettes, dépenses, déclarations de cotisations, exports et réglages.
// Les recettes viennent des factures réelles payées (module « Devis & factures ») ; les documents de test n'y entrent jamais.
import { h, api, attempt, toast, modal, confirmBox, formModal, sectionHead, card, pill, btn, emptyState, segmented, gauge, columns, bars, icon } from '../lib.js';

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur = (cents) => fmt.format((cents || 0) / 100);
const euros = (cents) => Math.round((cents || 0) / 100);
const toCents = (v) => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const fromCents = (c) => (c / 100).toFixed(2).replace('.', ',');
const dateShort = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const dateLong = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysUntil = (iso) => Math.round((new Date(iso + 'T12:00') - new Date(todayIso() + 'T12:00')) / 86400000);
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const CATEGORIES = [['hebergement', 'Hébergement, domaine, serveur'], ['logiciels', 'Logiciels et abonnements'], ['materiel', 'Matériel'], ['assurance', 'Assurance'], ['banque', 'Banque'],
  ['formation', 'Formation'], ['deplacements', 'Déplacements'], ['cotisations', 'Cotisations, CFE, impôts'], ['marketing', 'Communication et publicité'], ['autre', 'Autre']];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
const ACTIVITIES = [['bnc', 'Prestations libérales (BNC)'], ['bic_services', 'Prestations commerciales ou artisanales (BIC)'], ['bic_vente', 'Vente de marchandises (BIC)']];
const PERIOD_STATUS = { open: ['En cours', 'sky'], todo: ['À déclarer', 'banana'], late: ['En retard', 'coral'], declared: ['Déclarée, à payer', 'peach'], paid: ['Payée', 'mint'] };

export async function render(root) {
  const state = { tab: 'dashboard', year: new Date().getFullYear(), data: null };
  const box = h('div', {});
  root.append(box);
  const load = async () => { state.data = await api(`accounting/overview?year=${state.year}`); draw(); };
  const draw = () => box.replaceChildren(view(state, load, draw));
  await load();
}

function view(state, load, draw) {
  const d = state.data;
  const tabs = segmented([['dashboard', 'Tableau de bord'], ['ledger', 'Recettes'], ['expenses', 'Dépenses'], ['declarations', 'Déclarations'], ['exports', 'Exports'], ['settings', 'Réglages']], state.tab, (v) => { state.tab = v; draw(); }, 'Section');
  const year = h('select', { class: 'input input-sm', 'aria-label': 'Année' }, d.years.map((y) => h('option', { value: y, selected: y === state.year || null }, String(y))));
  year.addEventListener('change', () => { state.year = Number(year.value); load(); });
  const head = sectionHead('Compta', 'Recettes encaissées, dépenses, cotisations à déclarer et plafonds de ta micro-entreprise.', tabs, state.tab === 'settings' ? null : year);
  const body = { dashboard: () => dashboardView(state, load, draw), ledger: () => ledgerView(state), expenses: () => expensesView(state, load), declarations: () => declarationsView(state, load), exports: () => exportsView(state), settings: () => settingsView(state, load) }[state.tab]();
  return h('div', { class: 'stack' }, head, body);
}

// ---------------------------------------------------------------- tableau de bord
function dashboardView(state, load, draw) {
  const d = state.data, s = d.settings;
  const tile = (v, l, c) => h('div', { class: ['kpi-tile', `c-${c}`] }, h('b', {}, v), h('span', {}, l));
  const pct = (v, max) => (max ? Math.round((100 * v) / max) : 0);
  const ceilPct = pct(d.revenue, d.thresholds.ceiling);
  const next = d.next;
  const nextCard = next
    ? card('Prochaine déclaration', h('div', { class: 'stack-sm' },
      h('p', {}, h('b', {}, next.label), ` : à déclarer avant le ${dateLong(next.due)}`, ' ', (() => { const n = daysUntil(next.due); return pill(n < 0 ? `en retard de ${-n} j` : n === 0 ? 'aujourd’hui' : `dans ${n} j`, n < 0 ? 'coral' : n <= 14 ? 'banana' : 'mint', 'pill-sm'); })()),
      h('p', {}, `Chiffre d’affaires encaissé sur la période : ${eur(next.revenue)} · cotisations estimées : ${eur(next.contribution)}.`),
      h('div', { class: 'btn-row' }, btn('Aller aux déclarations', () => { state.tab = 'declarations'; draw(); }, { kind: 'primary', iconName: 'wallet' }),
        h('a', { class: 'btn', href: 'https://www.autoentrepreneur.urssaf.fr', target: '_blank', rel: 'noopener noreferrer' }, icon('external-link'), h('span', {}, 'Ouvrir autoentrepreneur.urssaf.fr')))), { color: next.status === 'late' ? 'coral' : 'banana' })
    : card('Prochaine déclaration', h('p', { class: 'muted' }, 'Rien à déclarer pour l’instant.'));
  const gauges = card('Plafonds', h('div', { class: 'stack' },
    ...[[`Plafond de chiffre d’affaires de la micro-entreprise (${eur(d.thresholds.ceiling)})`, d.thresholds.ceiling, 80, 95],
      [`Franchise de TVA, seuil de base (${eur(d.thresholds.vat_base)})`, d.thresholds.vat_base, 80, 100],
      [`Franchise de TVA, seuil majoré (${eur(d.thresholds.vat_major)})`, d.thresholds.vat_major, 80, 100]]
      .map(([label, max, warn, bad]) => h('div', {}, h('div', { class: 'row-between' }, h('small', {}, label), h('b', {}, `${pct(d.revenue, max)} %`)), gauge(pct(d.revenue, max), { warn, bad, label }))),
    h('small', { class: 'muted' }, `Calculé sur ${eur(d.revenue)} encaissés en ${d.year}. Au-delà du seuil de franchise, la TVA s’applique : préviens ton comptable avant. Seuils et plafonds modifiables dans Réglages (à vérifier sur autoentrepreneur.urssaf.fr).`)));
  const reminders = card('Rappels de l’année', h('ul', { class: 'rows' },
    ...[['Déclaration de chiffre d’affaires', 'Chaque ' + (s.frequency === 'month' ? 'mois' : 'trimestre') + ', même à 0 €, sur autoentrepreneur.urssaf.fr (voir « Prochaine déclaration »).'],
      ['CFE (cotisation foncière des entreprises)', 'À payer avant le 15 décembre ; en général exonérée la première année (avis sur impots.gouv.fr).'],
      ['Impôt sur le revenu', 'Déclaration de revenus au printemps (mai-juin) : reporte ton chiffre d’affaires annuel.'],
      ['Facturation électronique', 'Réception obligatoire depuis septembre 2026 ; émission via une plateforme agréée à partir de septembre 2027.']]
      .map(([t, x]) => h('li', {}, h('span', { class: 'grow' }, h('b', {}, t), h('div', { class: 'muted small' }, x))))));
  const months = columns(d.months.map((v, i) => ({ label: MONTHS[i], value: Math.max(0, euros(v)), title: `${MONTHS[i]} : ${eur(v)}` })), { color: 'mint', unit: ' €' });
  const empty = !d.count && !d.expenses_total;
  return h('div', { class: 'stack' },
    empty ? emptyState(`Aucune recette en ${d.year}. Elles apparaissent ici dès qu’une facture réelle est marquée payée dans « Devis & factures ».`) : null,
    h('div', { class: 'kpi-grid' },
      tile(eur(d.revenue), `encaissé en ${d.year} (${ceilPct} % du plafond)`, ceilPct >= 80 ? 'coral' : 'mint'),
      tile(eur(d.contributions), 'de cotisations estimées', 'banana'),
      tile(eur(d.expenses_total), 'de dépenses suivies', 'paper'),
      tile(eur(d.net), 'de résultat estimé (hors impôt)', d.net >= 0 ? 'sky' : 'coral'),
      tile(eur(d.unpaid.total), `à encaisser (${d.unpaid.count} facture${d.unpaid.count > 1 ? 's' : ''}${d.unpaid.overdue ? `, ${d.unpaid.overdue} en retard` : ''})`, d.unpaid.overdue ? 'coral' : 'lilac')),
    nextCard,
    h('div', { class: 'grid grid-2' }, card('Chiffre d’affaires par mois', months), card('Meilleurs clients', bars(Object.entries(d.top_clients).map(([label, v]) => ({ label, value: euros(v) })), { color: 'sky', empty: 'Aucun encaissement.' }))),
    h('div', { class: 'grid grid-2' }, gauges, reminders),
    h('p', { class: 'muted small' }, 'Les cotisations sont une estimation à partir de tes réglages (taux, ACRE, versement libératoire) : le montant exact est celui indiqué sur autoentrepreneur.urssaf.fr au moment de déclarer.'));
}

// ---------------------------------------------------------------- livre des recettes
function ledgerView(state) {
  const year = state.year;
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  api(`accounting/ledger?year=${year}`).then((r) => {
    const rows = r.entries.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['N°', 'Date', 'Référence', 'Client', 'Nature', 'Règlement', 'Montant'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, r.entries.map((e, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', { class: 'nowrap' }, dateShort(e.date)), h('td', {}, h('b', {}, e.number), e.refund ? [' ', pill('remboursement', 'coral', 'pill-sm')] : null),
          h('td', {}, e.client), h('td', { class: 'clamp' }, e.subject || '—'), h('td', {}, e.method || '—'), h('td', { class: 'nowrap' }, eur(e.amount))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 6 }, h('b', {}, `Total ${year}`)), h('td', { class: 'nowrap' }, h('b', {}, eur(r.total)))))))
      : emptyState(`Aucun encaissement en ${year}.`);
    box.replaceChildren(h('div', { class: 'row-between' }, h('p', { class: 'muted' }, 'Le livre des recettes est obligatoire : il liste chaque encaissement, dans l’ordre. Il se remplit tout seul quand tu marques une facture payée.'),
      h('div', { class: 'btn-row' }, btn('Imprimer / PDF', () => printLedger(r, year), { kind: 'primary', iconName: 'printer' }),
        h('a', { class: 'btn', href: `/api/accounting/export?type=ledger&year=${year}`, download: '' }, icon('download'), h('span', {}, 'CSV')))), rows);
  }).catch((e) => box.replaceChildren(h('p', { class: 'error' }, e.message)));
  return box;
}

function printLedger(r, year) {
  const s = r.seller;
  const sheet = h('article', { class: 'sheet', 'aria-label': 'Livre des recettes' },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-seller' }, h('b', { class: 'sheet-brand' }, s.brand || s.name), h('div', {}, `${s.name} EI`), s.siret ? h('div', {}, `SIRET ${s.siret}`) : null),
      h('div', { class: 'sheet-title' }, h('h2', {}, 'LIVRE DES RECETTES'), h('p', {}, `Année ${year}`), h('p', {}, `Édité le ${dateLong(todayIso())}`))),
    h('table', { class: 'sheet-table' },
      h('thead', {}, h('tr', {}, ['N°', 'Date', 'Référence', 'Client', 'Nature', 'Règlement'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col', class: 'num' }, 'Montant'))),
      h('tbody', {}, r.entries.map((e, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, dateShort(e.date)), h('td', {}, e.number), h('td', {}, e.client), h('td', {}, e.subject), h('td', {}, e.method), h('td', { class: 'num' }, eur(e.amount)))))),
    h('div', { class: 'sheet-total' }, h('span', {}, `Total des recettes ${year}`), h('b', {}, eur(r.total))),
    h('footer', { class: 'sheet-foot' }, h('p', {}, 'Encaissements professionnels, dans l’ordre chronologique, établis à partir des factures réglées. Les justificatifs (factures) sont conservés 10 ans.')));
  modal({ title: `Livre des recettes ${year}`, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'btn-row doc-actions' }, btn('Imprimer / PDF', () => window.print(), { kind: 'primary', iconName: 'printer' })), h('div', { class: 'sheet-wrap' }, sheet)) });
}

// ---------------------------------------------------------------- dépenses
function expensesView(state, load) {
  const year = state.year;
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  const reload = () => api(`accounting/expenses?year=${year}`).then((r) => {
    const total = r.expenses.reduce((a, e) => a + e.amount, 0);
    const byCat = {};
    r.expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
    const add = btn('Nouvelle dépense', () => expenseForm(null, year, async () => { await reload(); await load(); }), { kind: 'primary', iconName: 'plus' });
    const table = r.expenses.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Date', 'Fournisseur', 'Libellé', 'Catégorie', 'Montant', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, r.expenses.map((e) => h('tr', {}, h('td', { class: 'nowrap' }, dateShort(e.date)), h('td', {}, e.supplier || '—'), h('td', { class: 'clamp' }, e.label, e.ref ? h('small', { class: 'muted' }, ` · ${e.ref}`) : null),
          h('td', {}, CATEGORY_LABEL[e.category] || e.category), h('td', { class: 'nowrap' }, eur(e.amount)),
          h('td', { class: 'nowrap' }, btn('Modifier', () => expenseForm(e, year, async () => { await reload(); await load(); }), { iconName: 'pencil' }),
            btn('', async () => { if (await confirmBox(`Supprimer la dépense « ${e.label} » ?`)) attempt(() => api('accounting/expense/delete', { body: { id: e.id } }), 'Dépense supprimée').then(async (x) => { if (x) { await reload(); await load(); } }); }, { kind: 'ghost', iconName: 'trash-2', title: 'Supprimer' }))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, h('b', {}, `Total ${year}`)), h('td', { colspan: 2, class: 'nowrap' }, h('b', {}, eur(total)))))))
      : emptyState(`Aucune dépense enregistrée en ${year}. Ajoute tes abonnements (serveur, domaine, logiciels…) : c’est facultatif en micro-entreprise, mais utile pour savoir ce qu’il te reste.`);
    box.replaceChildren(h('div', { class: 'row-between' }, h('p', { class: 'muted' }, 'Suivi facultatif : en micro-entreprise, tes dépenses ne réduisent pas tes cotisations. Garde les factures 10 ans.'),
      h('div', { class: 'btn-row' }, add, h('a', { class: 'btn', href: `/api/accounting/export?type=expenses&year=${year}`, download: '' }, icon('download'), h('span', {}, 'CSV')))),
      table, Object.keys(byCat).length ? card('Par catégorie', bars(Object.entries(byCat).map(([k, v]) => ({ label: CATEGORY_LABEL[k] || k, value: euros(v) })).sort((a, b) => b.value - a.value), { color: 'lilac' })) : null);
  }).catch((e) => box.replaceChildren(h('p', { class: 'error' }, e.message)));
  reload();
  return box;
}

function expenseForm(e, year, done) {
  formModal({ title: e ? 'Modifier la dépense' : 'Nouvelle dépense', submit: 'Enregistrer',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, value: e ? e.date : (year === new Date().getFullYear() ? todayIso() : `${year}-01-01`) },
      { name: 'label', label: 'Libellé', required: true, max: 160, value: e?.label, placeholder: 'VPS IONOS, nom de domaine, abonnement…' },
      { name: 'supplier', label: 'Fournisseur', max: 80, value: e?.supplier },
      { name: 'amount', label: 'Montant TTC (€)', required: true, value: e ? fromCents(e.amount) : '', placeholder: '12,00' },
      { name: 'category', label: 'Catégorie', type: 'select', value: e?.category || 'autre', options: CATEGORIES },
      { name: 'method', label: 'Mode de règlement', max: 30, value: e?.method, placeholder: 'carte, virement…' },
      { name: 'ref', label: 'N° de la facture ou de la pièce', max: 60, value: e?.ref },
      { name: 'note', label: 'Note', max: 300, value: e?.note }],
    onSubmit: async (v) => {
      const amount = toCents(v.amount);
      if (amount <= 0) throw new Error('Saisis un montant positif.');
      await api('accounting/expense', { body: { ...v, amount, id: e?.id } });
      await done(); toast('Dépense enregistrée ✓', 'good');
    } });
}

// ---------------------------------------------------------------- déclarations
function declarationsView(state, load) {
  const d = state.data, s = d.settings;
  const rows = d.periods.map((p) => {
    const [label, color] = PERIOD_STATUS[p.status];
    return h('tr', {}, h('td', {}, h('b', {}, p.label)), h('td', { class: 'nowrap' }, eur(p.revenue)), h('td', { class: 'nowrap' }, eur(p.contribution), p.vl ? h('small', { class: 'muted' }, ` (dont ${eur(p.vl)} d’impôt)`) : null),
      h('td', { class: 'nowrap' }, dateShort(p.due)), h('td', {}, pill(label, color, 'pill-sm'), p.paid_at ? h('small', { class: 'muted' }, ` ${dateShort(p.paid_at)}`) : null),
      h('td', { class: 'nowrap' }, btn(p.declared_at ? 'Modifier' : 'Marquer déclarée', () => declarationForm(p, load), { kind: p.status === 'todo' || p.status === 'late' ? 'primary' : '', iconName: 'circle-check' })));
  });
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Période', 'CA encaissé', 'Cotisations estimées', 'À déclarer avant', 'État', ''].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows)));
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Déclaration ${s.frequency === 'month' ? 'mensuelle' : 'trimestrielle'} du chiffre d’affaires encaissé, à faire sur autoentrepreneur.urssaf.fr, même quand il est à 0 €. Cotisations estimées : ${s.rate} %${s.extra_rate ? ` + ${s.extra_rate} %` : ''}${s.acre ? `, ACRE −${s.acre} %` : ''}${s.vl_rate ? `, versement libératoire ${s.vl_rate} %` : ''}.`),
    table,
    h('p', { class: 'muted small' }, 'Ici tu notes ce que tu as déclaré et payé : l’outil ne se connecte pas à l’URSSAF. Le montant exact à payer est celui affiché par l’URSSAF au moment de déclarer.'));
}

function declarationForm(p, load) {
  formModal({ title: `Déclaration — ${p.label}`, submit: 'Enregistrer',
    fields: [
      { name: 'declared_at', label: 'Déclarée le', type: 'date', required: true, value: p.declared_at || todayIso() },
      { name: 'revenue_declared', label: 'Chiffre d’affaires déclaré (€)', value: fromCents(p.revenue_declared ?? p.revenue) },
      { name: 'paid_at', label: 'Payée le (facultatif)', type: 'date', value: p.paid_at || '' },
      { name: 'amount_paid', label: 'Montant payé (€, facultatif)', value: p.amount_paid != null ? fromCents(p.amount_paid) : '', hint: `Estimation : ${eur(p.contribution)}` },
      { name: 'note', label: 'Note', max: 300, value: p.note }],
    extra: p.declared_at ? [btn('Effacer cette déclaration', async () => { if (await confirmBox('Effacer ce que tu as noté pour cette période ?')) attempt(() => api('accounting/declaration', { body: { period: p.key, clear: true } }), 'Déclaration effacée').then((r) => { if (r) { document.querySelector('.overlay')?.remove(); load(); } }); }, { kind: 'danger', iconName: 'trash-2' })] : [],
    onSubmit: async (v) => {
      await api('accounting/declaration', { body: { period: p.key, declared_at: v.declared_at, revenue_declared: toCents(v.revenue_declared), paid_at: v.paid_at || '', amount_paid: v.amount_paid === '' ? '' : toCents(v.amount_paid), note: v.note } });
      await load(); toast('Déclaration enregistrée ✓', 'good');
    } });
}

// ---------------------------------------------------------------- exports et bilan
function exportsView(state) {
  const y = state.year, d = state.data;
  const dl = (label, type, text) => card(label, h('div', { class: 'stack-sm' }, h('p', { class: 'muted' }, text), h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary', href: `/api/accounting/export?type=${type}&year=${y}`, download: '' }, icon('download'), h('span', {}, type === 'archive' ? 'Télécharger l’archive' : `Télécharger (${y})`)))));
  return h('div', { class: 'stack' },
    h('div', { class: 'grid grid-2' },
      dl('Livre des recettes (CSV)', 'ledger', 'Tous les encaissements de l’année, prêt pour Excel ou LibreOffice. Pour l’imprimer en PDF, utilise l’onglet Recettes.'),
      dl('Factures et avoirs (CSV)', 'invoices', 'Liste des factures et avoirs émis dans l’année, avec client, SIREN, total, échéance et paiement.'),
      dl('Dépenses (CSV)', 'expenses', 'Les dépenses suivies dans l’année, par date et catégorie.'),
      dl('Archive complète (JSON)', 'archive', 'Tous les documents émis avec leur contenu figé, les clients, les dépenses et les déclarations : ta copie de conservation sur 10 ans, à garder hors du serveur.')),
    card('Bilan de l’année', h('div', { class: 'stack-sm' }, h('p', { class: 'muted' }, 'Une page récapitulative à imprimer : chiffre d’affaires par mois, cotisations, dépenses, résultat estimé.'),
      h('div', { class: 'btn-row' }, btn('Voir le bilan', () => printSummary(d, y), { kind: 'primary', iconName: 'file-text' })))));
}

function printSummary(d, year) {
  const s = d.settings;
  const sheet = h('article', { class: 'sheet', 'aria-label': 'Bilan annuel' },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-seller' }, h('b', { class: 'sheet-brand' }, 'StudioGLSC'), h('div', {}, 'Gabin Lescoat EI')), h('div', { class: 'sheet-title' }, h('h2', {}, 'BILAN ANNUEL'), h('p', {}, `Année ${year}`), h('p', {}, `Édité le ${dateLong(todayIso())}`))),
    h('table', { class: 'sheet-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Mois'), h('th', { class: 'num' }, 'Chiffre d’affaires encaissé'))),
      h('tbody', {}, d.months.map((v, i) => h('tr', {}, h('td', {}, MONTHS[i]), h('td', { class: 'num' }, eur(v)))))),
    h('div', { class: 'sheet-total' }, h('span', {}, 'Chiffre d’affaires encaissé'), h('b', {}, eur(d.revenue))),
    h('table', { class: 'sheet-table' }, h('tbody', {},
      h('tr', {}, h('td', {}, `Cotisations estimées (${s.rate}%${s.extra_rate ? ` + ${s.extra_rate}%` : ''}${s.acre ? `, ACRE −${s.acre}%` : ''}${s.vl_rate ? `, versement libératoire ${s.vl_rate}%` : ''})`), h('td', { class: 'num' }, eur(d.contributions))),
      h('tr', {}, h('td', {}, 'Dépenses suivies'), h('td', { class: 'num' }, eur(d.expenses_total))),
      h('tr', {}, h('td', {}, h('b', {}, 'Résultat estimé (avant impôt sur le revenu)')), h('td', { class: 'num' }, h('b', {}, eur(d.net)))))),
    h('footer', { class: 'sheet-foot' }, h('p', {}, 'Document de pilotage établi à partir des factures réglées et des réglages de la compta. Il ne remplace pas les déclarations officielles.')));
  modal({ title: `Bilan ${year}`, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'btn-row doc-actions' }, btn('Imprimer / PDF', () => window.print(), { kind: 'primary', iconName: 'printer' })), h('div', { class: 'sheet-wrap' }, sheet)) });
}

// ---------------------------------------------------------------- réglages
function settingsView(state, load) {
  const s = state.data.settings, df = s.defaults;
  const f = {};
  const field = (key, label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), (f[key] = input), hint ? h('small', { class: 'hint' }, hint) : null);
  const num = (key, label, value, hint) => field(key, label, h('input', { class: 'input', value: value == null ? '' : String(value).replace('.', ','), inputmode: 'decimal', autocomplete: 'off' }), hint);
  const activity = h('select', { class: 'input' }, ACTIVITIES.map(([v, l]) => h('option', { value: v, selected: v === s.activity || null }, l)));
  const freq = h('select', { class: 'input' }, [['quarter', 'Trimestrielle'], ['month', 'Mensuelle']].map(([v, l]) => h('option', { value: v, selected: v === s.frequency || null }, l)));
  const start = h('input', { class: 'input', type: 'date', value: s.start_date || '' });
  const save = btn('Enregistrer', async () => {
    const body = { activity: activity.value, frequency: freq.value, start_date: start.value,
      ...Object.fromEntries(['rate', 'extra_rate', 'acre', 'vl_rate', 'ceiling', 'vat_base', 'vat_major'].map((k) => [k, f[k].value])) };
    const r = await attempt(() => api('accounting/settings', { body }), 'Réglages enregistrés ✓');
    if (r) load();
  }, { kind: 'primary', iconName: 'save' });
  return h('div', { class: 'stack' },
    card('À vérifier avant de t’en servir', h('p', {}, 'Les taux et seuils proposés sont ceux publiés pour 2026 ; ils changent régulièrement. Vérifie-les sur autoentrepreneur.urssaf.fr et modifie-les ici si besoin : tous les calculs de l’outil en dépendent.'), { color: 'banana' }),
    card('Ton activité', h('div', { class: 'grid grid-2' }, field('activity', 'Catégorie d’activité', activity), field('frequency', 'Fréquence de déclaration', freq), field('start_date', 'Date de création (facultatif)', start))),
    card('Cotisations', h('div', { class: 'grid grid-2' },
      num('rate', 'Taux de cotisations sociales (%)', s.rate, `Par défaut pour cette activité : ${String(df.rate).replace('.', ',')} %`),
      num('extra_rate', 'Contributions en plus (%)', s.extra_rate, 'Ex. contribution à la formation professionnelle, si elle n’est pas déjà comprise dans le taux ci-dessus'),
      num('acre', 'Réduction ACRE (%)', s.acre, 'Aide à la création : 0 si tu n’en bénéficies pas, sinon la part de réduction indiquée par l’URSSAF'),
      num('vl_rate', 'Versement libératoire de l’impôt (%)', s.vl_rate, '0 si tu n’as pas choisi cette option'))),
    card('Plafonds', h('div', { class: 'grid grid-2' },
      num('ceiling', 'Plafond de chiffre d’affaires (€)', s.ceiling, `Par défaut : ${df.ceiling.toLocaleString('fr-FR')} €`),
      num('vat_base', 'Franchise de TVA, seuil de base (€)', s.vat_base, `Par défaut : ${df.vat_base.toLocaleString('fr-FR')} €`),
      num('vat_major', 'Franchise de TVA, seuil majoré (€)', s.vat_major, `Par défaut : ${df.vat_major.toLocaleString('fr-FR')} €`))),
    h('div', { class: 'btn-row' }, save));
}
