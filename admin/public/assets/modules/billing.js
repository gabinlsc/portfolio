// Devis & factures : clients, devis, factures (acompte / solde / complète), avoirs, réglages du vendeur et guide.
// Les documents émis sont figés côté serveur ; l'impression en PDF se fait depuis l'aperçu (bouton « Imprimer / PDF »).
import { h, api, attempt, toast, modal, confirmBox, formModal, sectionHead, card, pill, btn, emptyState, segmented, copy, icon } from '../lib.js';

// ---------------------------------------------------------------- catalogue (à garder aligné avec glsc-studio/tools/content/offres.mjs)
const CATALOG = [
  ['Création du site', [
    ['Express : site d’une page, première version en 48 h', 59000],
    ['Pack Lancement : site Express, fiche Google, kit réseaux sociaux, retouche de 10 photos', 79000],
    ['Vitrine : site de plusieurs pages (à ajuster selon le devis)', 99000],
    ['Boutique en ligne : catalogue, panier, paiement (à ajuster selon le devis)', 149000],
  ]],
  ['Options', [
    ['Fiche Google Business Profile : création ou optimisation', 15000],
    ['Kit réseaux sociaux : avatar, bannière et trois visuels', 9000],
    ['Retouche photo : jusqu’à 10 photos', 6000],
    ['Page supplémentaire', 12000],
  ]],
  ['Abonnements Sérénité (avec un site)', [
    ['Sérénité Essentiel : hébergement, sécurité et sauvegardes (1 mois)', 2900, 'mois'],
    ['Sérénité Plus : 1 h de modifications par mois (1 mois)', 5900, 'mois'],
    ['Sérénité Croissance : 3 h de modifications par mois (1 mois)', 9900, 'mois'],
    ['Sérénité Essentiel, à l’année (2 mois offerts)', 29000, 'an'],
    ['Sérénité Plus, à l’année (2 mois offerts)', 59000, 'an'],
    ['Sérénité Croissance, à l’année (2 mois offerts)', 99000, 'an'],
  ]],
  ['Divers', [
    ['Modifications hors forfait', 4500, 'h'],
    ['Remise commerciale', -5000],
  ]],
];

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur = (cents) => fmt.format((cents || 0) / 100);
const toCents = (v) => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const fromCents = (c) => (c / 100).toFixed(2).replace('.', ',');
const lineTotal = (l) => Math.round(Math.round(Number(l.qty) * 100) * l.unit / 100 + (l.unit < 0 ? -1e-9 : 1e-9));
const sum = (lines) => lines.reduce((a, l) => a + lineTotal(l), 0);
const dateLong = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const dateShort = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const todayIso = () => new Date().toISOString().slice(0, 10);

const KIND = { quote: 'Devis', invoice: 'Facture', credit: 'Avoir' };
const SUBTYPE = { deposit: 'Facture d’acompte', balance: 'Facture de solde', full: 'Facture' };
const STATUS = {
  draft: ['Brouillon', 'paper'], issued: ['Émis', 'sky'], accepted: ['Accepté', 'mint'], refused: ['Refusé', 'coral'],
  paid: ['Payée', 'mint'], credited: ['Annulée (avoir)', 'paper'],
};
const docTitle = (d) => (d.kind === 'invoice' ? SUBTYPE[d.subtype] || 'Facture' : KIND[d.kind]);
const statusPill = (d) => {
  if (d.overdue) return pill('En retard', 'coral', 'pill-sm');
  if (d.expired) return pill('Expiré', 'peach', 'pill-sm');
  const [label, color] = STATUS[d.status] || [d.status, 'paper'];
  return pill(d.kind === 'quote' && d.status === 'issued' ? 'Envoyé' : label, color, 'pill-sm');
};

export async function render(root) {
  const state = { tab: 'quotes', data: null };
  const box = h('div', {});
  root.append(box);
  const load = async () => { state.data = await api('billing/overview'); draw(); };
  const draw = () => box.replaceChildren(view(state, load, draw));
  await load();
}

function view(state, load, draw) {
  const d = state.data;
  const tabs = segmented([['quotes', 'Devis'], ['invoices', 'Factures'], ['clients', 'Clients'], ['settings', 'Réglages'], ['guide', 'Guide']], state.tab, (v) => { state.tab = v; draw(); }, 'Section');
  const head = sectionHead('Devis & factures', 'Clients professionnels, TVA non applicable (art. 293 B du CGI). Les documents émis sont numérotés et figés.', tabs);
  const missing = d.missing.length && state.tab !== 'settings'
    ? card('Avant ton premier document', h('div', { class: 'stack-sm' }, h('p', {}, `Pour émettre un devis ou une facture, renseigne ${d.missing.join(', ')}. Tu peux déjà préparer des brouillons.`),
      btn('Ouvrir les réglages', () => { state.tab = 'settings'; draw(); }, { kind: 'primary', iconName: 'settings' })), { color: 'banana' }) : null;
  const body = { quotes: () => docsView(state, load, 'quote'), invoices: () => docsView(state, load, 'invoice'), clients: () => clientsView(state, load), settings: () => settingsView(state, load), guide: guideView }[state.tab]();
  return h('div', { class: 'stack' }, head, missing, state.tab === 'quotes' || state.tab === 'invoices' ? kpis(d.stats) : null, body);
}

function kpis(s) {
  const pct = s.limit ? Math.min(100, Math.round((100 * s.revenue) / s.limit)) : 0;
  const tile = (v, l, c) => h('div', { class: ['kpi-tile', `c-${c}`] }, h('b', {}, v), h('span', {}, l));
  return h('div', { class: 'kpi-grid' },
    tile(eur(s.revenue), `encaissé en ${s.year}${s.limit ? ` (${pct} % du plafond réglé)` : ''}`, pct >= 90 ? 'coral' : 'mint'),
    tile(eur(s.unpaid), 'à encaisser (factures émises)', s.unpaid ? 'banana' : 'paper'),
    tile(eur(s.quotes_open), 'de devis en attente de réponse', 'sky'));
}

// ---------------------------------------------------------------- listes
function docsView(state, load, kind) {
  const d = state.data;
  const rows = d.docs.filter((x) => (kind === 'invoice' ? x.kind === 'invoice' || x.kind === 'credit' : x.kind === 'quote'));
  const add = btn(kind === 'quote' ? 'Nouveau devis' : 'Nouvelle facture', () => editDoc(state, load, { kind }), { kind: 'primary', iconName: 'plus' });
  if (!d.clients.length) return h('div', { class: 'stack' }, emptyState('Ajoute d’abord un client pour pouvoir créer un document.', btn('Ajouter un client', () => { state.tab = 'clients'; load(); }, { kind: 'primary', iconName: 'plus' })));
  const table = rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Numéro', 'Client', 'Objet', 'Date', 'Montant', 'Statut', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('b', {}, r.number || 'Brouillon'), r.parent_number ? h('small', { class: 'muted' }, ` · ${r.parent_number}`) : null),
        h('td', {}, r.client), h('td', { class: 'clamp' }, r.kind === 'invoice' && r.subtype !== 'full' ? `${SUBTYPE[r.subtype] || ''} · ${r.subject}` : r.subject || '—'),
        h('td', { class: 'nowrap' }, dateShort(r.issue_date)), h('td', { class: 'nowrap' }, eur(r.total)), h('td', {}, statusPill(r)),
        h('td', { class: 'nowrap' }, btn('Ouvrir', () => openDoc(state, load, r.id), { iconName: 'file-text' })))))))
    : emptyState(kind === 'quote' ? 'Aucun devis pour l’instant. Crée-en un : choisis un client, ajoute des lignes depuis le catalogue, puis émets-le.' : 'Aucune facture. Elles se créent à partir d’un devis accepté (acompte, solde ou facture complète).');
  return h('div', { class: 'stack' }, h('div', { class: 'row-between' }, h('p', { class: 'muted' }, kind === 'quote' ? 'Un devis émis reçoit son numéro et ne peut plus être modifié.' : 'Une facture émise ne se modifie plus : on la corrige par un avoir.'), add), table);
}

// ---------------------------------------------------------------- éditeur de brouillon
function editDoc(state, load, init, id) {
  const d = state.data, s = d.seller;
  const isQuote = init.kind === 'quote';
  const doc = Object.assign({ client_id: d.clients[0]?.id, subject: '', lines: [{ desc: '', qty: 1, unit: 0 }], delivery: '', notes: '',
    deposit_percent: Number(s.deposit), terms_days: Number(isQuote ? s.valid_days : s.pay_days) }, init);
  const lines = doc.lines.map((l) => ({ ...l }));
  const clientSel = h('select', { class: 'input', 'aria-label': 'Client' }, d.clients.map((c) => h('option', { value: c.id, selected: String(c.id) === String(doc.client_id) || null }, c.name)));
  const subject = h('input', { class: 'input', value: doc.subject, maxlength: 160, placeholder: isQuote ? 'Création du site vitrine' : 'Objet de la facture', 'aria-label': 'Objet' });
  const delivery = h('input', { class: 'input', value: doc.delivery, maxlength: 300, placeholder: 'Ex. première version sous 48 h après réception des contenus', 'aria-label': 'Délai de réalisation' });
  const notes = h('textarea', { class: 'input', rows: 2, maxlength: 1000, 'aria-label': 'Notes', placeholder: 'Mention libre affichée sur le document (facultatif)' }, doc.notes);
  const deposit = h('input', { class: 'input input-sm', type: 'number', min: 0, max: 100, value: doc.deposit_percent, 'aria-label': 'Acompte en pourcentage' });
  const terms = h('input', { class: 'input input-sm', type: 'number', min: 0, max: 365, value: doc.terms_days, 'aria-label': isQuote ? 'Validité en jours' : 'Délai de paiement en jours' });
  const serviceDate = h('input', { class: 'input', type: 'date', value: doc.service_date || '', 'aria-label': 'Date de la prestation' });
  const totalOut = h('b', {}, eur(0));
  const body = h('tbody', {});
  const refresh = () => { totalOut.textContent = eur(sum(lines)); };
  const drawLines = () => {
    body.replaceChildren(...lines.map((l, i) => {
      const desc = h('input', { class: 'input', value: l.desc, maxlength: 300, placeholder: 'Description', 'aria-label': `Description ligne ${i + 1}`, oninput: () => { l.desc = desc.value; } });
      const qty = h('input', { class: 'input input-sm', value: String(l.qty).replace('.', ','), inputmode: 'decimal', 'aria-label': `Quantité ligne ${i + 1}`, oninput: () => { l.qty = parseFloat(qty.value.replace(',', '.')) || 0; refresh(); } });
      const unit = h('input', { class: 'input input-sm', value: fromCents(l.unit), inputmode: 'decimal', 'aria-label': `Prix unitaire ligne ${i + 1}`, oninput: () => { l.unit = toCents(unit.value); refresh(); } });
      return h('tr', {}, h('td', {}, desc), h('td', {}, qty), h('td', {}, unit, l.unitLabel ? h('small', { class: 'muted' }, ` € / ${l.unitLabel}`) : h('small', { class: 'muted' }, ' €')),
        h('td', { class: 'nowrap' }, h('small', { class: 'muted' }, ''), h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Supprimer la ligne ${i + 1}`, onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push({ desc: '', qty: 1, unit: 0 }); drawLines(); refresh(); } }, icon('trash-2'))));
    }));
    refresh();
  };
  const catalog = h('select', { class: 'input', 'aria-label': 'Ajouter depuis le catalogue', onchange: () => {
    if (!catalog.value) return;
    const [g, i] = catalog.value.split(':').map(Number);
    const [desc, unit, unitLabel] = CATALOG[g][1][i];
    if (lines.length === 1 && !lines[0].desc && !lines[0].unit) lines.length = 0;
    lines.push({ desc, qty: 1, unit, unitLabel: unitLabel || '' });
    catalog.value = ''; drawLines();
  } }, h('option', { value: '' }, 'Ajouter depuis le catalogue…'), CATALOG.map(([group, items], g) => h('optgroup', { label: group }, items.map(([desc, unit], i) => h('option', { value: `${g}:${i}` }, `${desc.split(' : ')[0]} · ${eur(unit)}`)))));
  drawLines();
  const payload = () => ({ id, kind: init.kind, client_id: Number(clientSel.value), subject: subject.value, delivery: delivery.value, notes: notes.value,
    deposit_percent: Number(deposit.value || 0), terms_days: Number(terms.value || 0), service_date: isQuote ? '' : serviceDate.value, lines: lines.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, unitLabel: l.unitLabel || '' })) });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = async (andOpen) => {
    try {
      const r = await api('billing/doc/save', { body: payload() });
      close(); await load(); if (andOpen) openDoc(state, load, r.id); else toast('Brouillon enregistré ✓', 'good');
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  };
  const content = h('div', { class: 'stack' },
    h('div', { class: 'grid grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Client'), clientSel), h('label', { class: 'field' }, h('span', {}, 'Objet'), subject)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Description', 'Quantité', 'Prix unitaire', ''].map((t) => h('th', { scope: 'col' }, t)))), body)),
    h('div', { class: 'row-between' }, catalog, btn('Ligne libre', () => { lines.push({ desc: '', qty: 1, unit: 0 }); drawLines(); }, { iconName: 'plus' })),
    h('p', { class: 'row-end' }, 'Total : ', totalOut, h('small', { class: 'muted' }, ' · TVA non applicable')),
    isQuote ? h('div', { class: 'grid grid-3' }, h('label', { class: 'field' }, h('span', {}, 'Acompte à la commande (%)'), deposit), h('label', { class: 'field' }, h('span', {}, 'Validité du devis (jours)'), terms),
      h('label', { class: 'field' }, h('span', {}, 'Délai de réalisation'), delivery))
      : h('div', { class: 'grid grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Délai de paiement (jours, 60 max.)'), terms),
        h('label', { class: 'field' }, h('span', {}, 'Date de la prestation (si différente de l’émission)'), serviceDate)),
    h('label', { class: 'field' }, h('span', {}, 'Note'), notes), error,
    h('div', { class: 'modal-actions' }, btn('Enregistrer le brouillon', () => save(false)), btn('Enregistrer et voir', () => save(true), { kind: 'primary', iconName: 'file-text' })));
  const close = modal({ title: `${id ? 'Modifier' : 'Nouveau'} ${isQuote ? 'devis' : 'facture'} (brouillon)`, body: content, wide: true });
}

// ---------------------------------------------------------------- aperçu, actions
async function openDoc(state, load, id) {
  const v = await api(`billing/doc?id=${id}`);
  const all = state.data.docs;
  const kids = all.filter((x) => x.parent_id === id);
  const sheetBox = h('div', { class: 'sheet-wrap' }, sheet(v));
  const act = (path, payload, msg, then) => attempt(() => api(path, { body: { id, ...payload } }), msg).then(async (r) => { if (r) { close(); await load(); if (then) then(r); } });
  const buttons = [];
  if (v.status === 'draft') {
    buttons.push(btn('Modifier', () => { close(); editDoc(state, load, { kind: v.kind, client_id: v.client_id, subject: v.subject, lines: v.lines, delivery: v.delivery, notes: v.notes, deposit_percent: v.deposit_percent, terms_days: v.terms_days, service_date: v.service_date }, id); }, { iconName: 'pencil' }));
    buttons.push(btn('Émettre (numéroter et figer)', async () => {
      const warn = v.kind !== 'quote' && !v.client.siren ? ' Le SIREN du client n’est pas renseigné : il devient obligatoire sur les factures entre professionnels.' : '';
      if (await confirmBox(`Une fois émis, ce ${KIND[v.kind].toLowerCase()} reçoit son numéro définitif et ne pourra plus être modifié.${warn}`, { ok: 'Émettre', danger: false })) act('billing/doc/issue', {}, (r) => `${r.number} émis ✓`, (r) => openDoc(state, load, id));
    }, { kind: 'primary', iconName: 'send' }));
    buttons.push(btn('Supprimer', async () => { if (await confirmBox('Supprimer ce brouillon ?')) act('billing/doc/delete', {}, 'Brouillon supprimé'); }, { kind: 'danger', iconName: 'trash-2' }));
  } else {
    buttons.push(btn('Imprimer / PDF', () => window.print(), { kind: 'primary', iconName: 'printer' }));
    buttons.push(btn('Copier le numéro', () => copy(v.number, 'Numéro copié'), { iconName: 'copy' }));
  }
  if (v.kind === 'quote' && v.status === 'issued') {
    buttons.push(btn('Marquer accepté', () => act('billing/doc/status', { status: 'accepted' }, 'Devis accepté ✓'), { iconName: 'circle-check' }));
    buttons.push(btn('Marquer refusé', () => act('billing/doc/status', { status: 'refused' }, 'Devis refusé')));
  }
  if (v.kind === 'quote' && (v.status === 'issued' || v.status === 'accepted')) {
    const live = kids.filter((k) => k.status !== 'credited');
    const dep = live.find((k) => k.subtype === 'deposit'), bal = live.find((k) => k.subtype === 'balance'), full = live.find((k) => k.subtype === 'full');
    const derive = (type, label) => buttons.push(btn(label, () => act('billing/doc/derive', { type }, 'Brouillon de facture créé ✓', (r) => { state.tab = 'invoices'; load().then(() => openDoc(state, load, r.id)); }), { iconName: 'plus' }));
    if (!live.length && v.deposit_percent > 0 && v.deposit_percent < 100) derive('deposit', `Facture d’acompte (${v.deposit_percent} %)`);
    if (!live.length) derive('full', 'Facture complète');
    if (dep && dep.status !== 'draft' && !bal) derive('balance', 'Facture de solde');
    buttons.push(btn('Dupliquer', () => act('billing/doc/duplicate', {}, 'Copie créée en brouillon ✓'), { iconName: 'copy' }));
  }
  if (v.kind === 'invoice' && v.status === 'issued') {
    buttons.push(btn('Marquer payée', () => formModal({ title: `Paiement de ${v.number}`, submit: 'Enregistrer', fields: [
      { name: 'paid_at', label: 'Date de réception', type: 'date', value: todayIso(), required: true },
      { name: 'method', label: 'Moyen de paiement', type: 'select', value: 'virement', options: [['virement', 'Virement'], ['cheque', 'Chèque'], ['carte', 'Carte'], ['especes', 'Espèces'], ['autre', 'Autre']] }],
      onSubmit: async (f) => { await api('billing/doc/status', { body: { id, status: 'paid', paid_at: f.paid_at, method: f.method } }); close(); await load(); toast('Paiement enregistré ✓', 'good'); } }), { kind: 'primary', iconName: 'circle-check' }));
  }
  if (v.kind === 'invoice' && v.status === 'paid') buttons.push(btn('Annuler le paiement', () => act('billing/doc/status', { status: 'issued' }, 'Paiement annulé')));
  if (v.kind === 'invoice' && (v.status === 'issued' || v.status === 'paid')) {
    buttons.push(btn('Créer un avoir (annuler)', async () => { if (await confirmBox('Créer un avoir qui annule cette facture ? Il sera en brouillon, à émettre ensuite.', { ok: 'Créer l’avoir', danger: false })) act('billing/doc/derive', { type: 'credit' }, 'Avoir créé en brouillon ✓', (r) => openDoc(state, load, r.id)); }, { iconName: 'rotate-cw' }));
  }
  const actions = h('div', { class: 'btn-row doc-actions' }, buttons);
  const close = modal({ title: v.number ? `${docTitle(v)} ${v.number}` : `${docTitle(v)} (brouillon)`, body: h('div', { class: 'stack' }, actions, sheetBox), wide: true });
}

/** Le document tel qu'il s'imprime : identité du vendeur, client, lignes, total, mentions légales. */
function sheet(v) {
  const s = v.seller, c = v.client, isQuote = v.kind === 'quote', isInvoice = v.kind === 'invoice', isCredit = v.kind === 'credit';
  const total = v.total;
  const dep = isQuote && v.deposit_percent > 0 && v.deposit_percent < 100 ? Math.round((total * v.deposit_percent) / 100) : 0;
  const sellerName = `${s.name} EI`;
  const cityLine = (o) => [o.postcode, o.city].filter(Boolean).join(' ');
  const line = (t) => (t ? h('div', {}, t) : null);
  const items = h('table', { class: 'sheet-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Désignation'), h('th', { scope: 'col', class: 'num' }, 'Qté'), h('th', { scope: 'col', class: 'num' }, 'Prix unitaire'), h('th', { scope: 'col', class: 'num' }, 'Total'))),
    h('tbody', {}, v.lines.map((l) => h('tr', {}, h('td', {}, l.desc), h('td', { class: 'num' }, `${String(l.qty).replace('.', ',')}${l.unitLabel ? ' ' + l.unitLabel : ''}`),
      h('td', { class: 'num' }, eur(l.unit)), h('td', { class: 'num' }, eur(lineTotal(l)))))));
  const mentions = [];
  mentions.push('TVA non applicable, article 293 B du CGI.');
  if (isQuote) {
    mentions.push('Devis établi pour un client professionnel. Les conditions générales de vente (https://studio.glsc.fr/cgv.html) s’appliquent et sont acceptées par la signature du présent devis.');
  } else {
    mentions.push('Catégorie d’opération : prestation de services.');
    mentions.push(`Paiement par virement. En cas de retard de paiement : pénalités au taux d’intérêt légal majoré de 10 points et indemnité forfaitaire de 40 € pour frais de recouvrement. Pas d’escompte pour paiement anticipé.`);
  }
  if (s.footer) mentions.push(s.footer);
  return h('article', { class: ['sheet', !v.frozen && 'is-draft'], 'aria-label': 'Aperçu du document' },
    !v.frozen ? h('div', { class: 'sheet-draft' }, 'BROUILLON — sans valeur tant qu’il n’est pas émis') : null,
    h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-seller' }, h('b', { class: 'sheet-brand' }, s.brand || s.name), line(sellerName), line(s.address), line(cityLine(s)), line(s.siret ? `SIRET ${s.siret}` : 'SIRET à renseigner'), line(s.email), line(s.phone)),
      h('div', { class: 'sheet-title' }, h('h2', {}, docTitle(v).toUpperCase()), h('p', {}, v.number || 'Numéro attribué à l’émission'),
        h('p', {}, `Date : ${dateLong(v.issue_date)}`),
        isQuote && v.valid_until ? h('p', {}, `Valable jusqu’au ${dateLong(v.valid_until)}`) : null,
        isInvoice && v.service_date ? h('p', {}, `Date de la prestation : ${dateLong(v.service_date)}`) : null,
        isInvoice && v.due_date ? h('p', {}, v.due_date === v.issue_date ? 'Échéance : à réception' : `Échéance : ${dateLong(v.due_date)}`) : null,
        v.parent_number ? h('p', {}, `${isCredit ? 'Facture annulée' : 'Devis'} : ${v.parent_number}`) : null)),
    h('section', { class: 'sheet-client' }, h('small', {}, isQuote ? 'Destinataire' : 'Facturé à'), h('b', {}, c.name), line(c.contact), line(c.address), line(cityLine(c)), line(c.country && c.country !== 'France' ? c.country : ''),
      line(c.siren ? `SIREN ${c.siren}` : null), line(c.vat_id ? `TVA intracommunautaire ${c.vat_id}` : null)),
    v.subject ? h('p', { class: 'sheet-subject' }, h('b', {}, 'Objet : '), v.subject) : null,
    items,
    h('div', { class: 'sheet-total' }, h('span', {}, isCredit ? 'Total de l’avoir' : isInvoice ? 'Total à payer' : 'Total'), h('b', {}, eur(total))),
    dep ? h('p', { class: 'sheet-cond' }, `Acompte de ${v.deposit_percent} % à la commande : ${eur(dep)}. Solde de ${eur(total - dep)} à la livraison, avant la mise en ligne définitive.`) : null,
    isQuote && v.delivery ? h('p', { class: 'sheet-cond' }, `Délai de réalisation : ${v.delivery}.`) : null,
    v.notes ? h('p', { class: 'sheet-cond pre-wrap' }, v.notes) : null,
    isInvoice && (s.iban || s.bic) ? h('p', { class: 'sheet-cond' }, h('b', {}, 'Règlement par virement : '), [s.bank, s.iban && `IBAN ${s.iban.replace(/(.{4})/g, '$1 ').trim()}`, s.bic && `BIC ${s.bic}`].filter(Boolean).join(' · '), v.number ? ` · référence ${v.number}` : '') : null,
    isQuote ? h('div', { class: 'sheet-sign' }, h('b', {}, 'Bon pour accord'), h('p', {}, 'Date, nom et signature du client, précédés de la mention « Bon pour accord » :'), h('div', { class: 'sheet-sign-box' }), h('small', {}, 'Le client déclare agir à titre professionnel.')) : null,
    v.paid_at ? h('p', { class: 'sheet-paid' }, `Payée le ${dateLong(v.paid_at)}${v.paid_method ? ` (${v.paid_method})` : ''}. Merci !`) : null,
    h('footer', { class: 'sheet-foot' }, mentions.map((m) => h('p', {}, m))));
}

// ---------------------------------------------------------------- clients
const CLIENT_FIELDS = [
  { name: 'name', label: 'Raison sociale ou nom', required: true, max: 120 }, { name: 'contact', label: 'Contact (facultatif)', max: 80 },
  { name: 'siren', label: 'SIREN', hint: '9 chiffres, obligatoire sur les factures entre professionnels (à partir de septembre 2026).', max: 14 }, { name: 'vat_id', label: 'N° de TVA intracommunautaire (facultatif)', max: 20 },
  { name: 'address', label: 'Adresse', max: 160 }, { name: 'postcode', label: 'Code postal', max: 10 }, { name: 'city', label: 'Ville', max: 80 }, { name: 'country', label: 'Pays', value: 'France', max: 60 },
  { name: 'email', label: 'E-mail', type: 'email', max: 120 }, { name: 'phone', label: 'Téléphone', max: 30 }, { name: 'note', label: 'Note privée', type: 'textarea', rows: 2, max: 500 },
];

async function clientForm(load, c) {
  let requests = [];
  if (!c) { try { requests = (await api('studio/overview')).requests || []; } catch { /* service indisponible : saisie manuelle */ } }
  const extra = requests.length ? [h('label', { class: 'field' }, h('span', {}, 'Préremplir depuis une demande reçue sur studio.glsc.fr'),
    h('select', { class: 'input', id: 'f-prefill', onchange: (e) => {
      const r = requests[Number(e.target.value)];
      if (!r) return;
      const set = (n, val) => { const el = document.getElementById('f-' + n); if (el && val) el.value = val; };
      set('name', r.name); set('email', r.email); set('phone', r.phone);
    } }, h('option', { value: '' }, '—'), requests.map((r, i) => h('option', { value: i }, `${r.name} · ${r.service}`))))] : [];
  formModal({ title: c ? 'Modifier le client' : 'Nouveau client', submit: 'Enregistrer', extra,
    fields: CLIENT_FIELDS.map((f) => ({ ...f, value: c ? c[f.name] : f.value })),
    onSubmit: async (v) => { await api('billing/client', { body: { ...v, id: c?.id } }); await load(); toast('Client enregistré ✓', 'good'); } });
}

function clientsView(state, load) {
  const d = state.data;
  const add = btn('Nouveau client', () => clientForm(load), { kind: 'primary', iconName: 'plus' });
  const rows = d.clients.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Client', 'SIREN', 'Contact', ''].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, d.clients.map((c) => h('tr', {}, h('td', {}, h('b', {}, c.name), h('div', { class: 'muted small' }, [c.postcode, c.city].filter(Boolean).join(' '))),
      h('td', {}, c.siren || h('small', { class: 'muted' }, 'à renseigner')), h('td', {}, c.email || c.phone || '—'),
      h('td', { class: 'nowrap' }, btn('Modifier', () => clientForm(load, c), { iconName: 'pencil' }),
        btn('', async () => { if (await confirmBox(`Supprimer le client « ${c.name} » ?`)) attempt(() => api('billing/client/delete', { body: { id: c.id } }), 'Client supprimé').then((r) => r && load()); }, { kind: 'ghost', iconName: 'trash-2', title: 'Supprimer' })))))))
    : emptyState('Aucun client. Ajoute celui de ton premier devis : raison sociale, adresse et SIREN (à demander au client).');
  return h('div', { class: 'stack' }, h('div', { class: 'row-between' }, h('p', { class: 'muted' }, 'Un client qui a des documents ne peut pas être supprimé (conservation légale de 10 ans).'), add), rows);
}

// ---------------------------------------------------------------- réglages
const SETTINGS = [
  ['Toi', [['name', 'Nom et prénom'], ['brand', 'Nom commercial']]],
  ['Entreprise', [['siret', 'SIRET (14 chiffres)'], ['siren', 'SIREN (déduit du SIRET)'], ['address', 'Adresse du siège'], ['postcode', 'Code postal'], ['city', 'Ville'], ['email', 'E-mail'], ['phone', 'Téléphone']]],
  ['Banque (affichée sur les factures)', [['bank', 'Banque'], ['iban', 'IBAN'], ['bic', 'BIC']]],
  ['Délais et plafond', [['pay_days', 'Paiement des factures (jours, 60 max.)'], ['valid_days', 'Validité des devis (jours)'], ['deposit', 'Acompte par défaut (%)'], ['ca_limit', 'Plafond de chiffre d’affaires annuel (€)']]],
  ['Mention libre', [['footer', 'Texte ajouté en bas des documents (facultatif)']]],
];

function settingsView(state, load) {
  const s = state.data.seller;
  const inputs = {};
  const sections = SETTINGS.map(([title, fields]) => card(title, h('div', { class: 'grid grid-2' }, fields.map(([k, label]) => {
    inputs[k] = h('input', { class: 'input', value: s[k] || '', id: 'bs-' + k, autocomplete: 'off', maxlength: 400 });
    return h('label', { class: 'field', for: 'bs-' + k }, h('span', {}, label), inputs[k]);
  }))));
  const save = btn('Enregistrer les réglages', async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const r = await attempt(() => api('billing/settings', { body }), 'Réglages enregistrés ✓');
    if (r) load();
  }, { kind: 'primary', iconName: 'save' });
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Ces informations figurent sur chaque devis et facture émis. Le SIRET te sera donné à l’immatriculation de ton entreprise.'), ...sections, h('div', { class: 'btn-row' }, save));
}

// ---------------------------------------------------------------- guide
function guideView() {
  const p = (...c) => h('p', {}, ...c);
  const li = (...c) => h('li', {}, ...c);
  return h('div', { class: 'stack' },
    card('Faire un devis en 5 minutes', h('ol', { class: 'stack-sm' },
      li('Onglet ', h('b', {}, 'Clients'), ' : ajoute le client (raison sociale, adresse, SIREN). Tu peux préremplir nom, e-mail et téléphone depuis une demande reçue sur le site.'),
      li('Onglet ', h('b', {}, 'Devis'), ' : « Nouveau devis », choisis le client, ajoute les lignes depuis le catalogue (prix du site), ajuste, puis « Enregistrer et voir ».'),
      li('Relis l’aperçu, puis « Émettre » : le devis reçoit son numéro (D-2026-001…) et ne peut plus changer.'),
      li('« Imprimer / PDF » → choisis « Enregistrer au format PDF » → envoie le PDF par e-mail au client.'),
      li('Le client répond « bon pour accord » : clique « Marquer accepté ».'))),
    card('Facturer', h('ol', { class: 'stack-sm' },
      li('Depuis le devis accepté : « Facture d’acompte » (50 %, due à réception). Émets-la, envoie-la, puis « Marquer payée » à réception du virement.'),
      li('À la livraison : « Facture de solde » (le total moins l’acompte déjà facturé). Ou « Facture complète » si tu factures en une fois.'),
      li('Une erreur sur une facture émise ? On ne la modifie pas : « Créer un avoir » l’annule, puis tu refais une facture correcte.'),
      li('La TVA ne s’applique pas (franchise en base, article 293 B du CGI) : la mention est ajoutée automatiquement.'))),
    card('Ce que la loi demande (résumé, à vérifier)', h('ul', { class: 'stack-sm' },
      li('Numérotation chronologique continue, sans trou : faite automatiquement (F-2026-001, F-2026-002…).'),
      li('Mentions de l’entreprise, du client, de la TVA, des pénalités de retard et de l’indemnité de 40 € : ajoutées automatiquement. Le SIREN du client devient obligatoire à partir du 1er septembre 2026.'),
      li('Conservation 10 ans : les documents émis ne se suppriment pas ; fais aussi une copie de sauvegarde régulière de la base (déjà incluse dans les sauvegardes chiffrées du serveur).'),
      li('Chiffre d’affaires : le tableau suit ce que tu as encaissé dans l’année pour surveiller le plafond de la micro-entreprise (à régler dans les réglages).'))),
    card('Facturation électronique', h('div', { class: 'stack-sm' },
      p('La réforme impose le passage par une ', h('b', {}, 'plateforme agréée'), ' (PA) pour les factures entre entreprises françaises. D’après les calendriers publiés : depuis le 1er septembre 2026, toute entreprise assujettie à la TVA (micro-entrepreneurs compris) doit pouvoir ', h('b', {}, 'recevoir'), ' des factures électroniques ; à partir du 1er septembre 2027, les micro-entreprises devront aussi les ', h('b', {}, 'émettre'), ' et transmettre leurs données (« e-reporting »).'),
      p('Ce module prépare et numérote tes devis et factures, avec les données exigées. Avant septembre 2027, tu peux envoyer ces factures en PDF. À partir de cette date, il faudra les émettre via la plateforme agréée de ton choix (liste officielle sur impots.gouv.fr) : choisis-en une dès maintenant, elle te servira aussi à recevoir les factures de tes fournisseurs.'),
      p('Vérifie le calendrier à jour sur impots.gouv.fr : les dates ont déjà été décalées une fois.'))));
}
