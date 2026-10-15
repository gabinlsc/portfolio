// Coffre à secrets : chiffré dans le navigateur (AES-GCM 256, clé dérivée de ta phrase secrète par PBKDF2).
// Le serveur ne stocke que du texte chiffré : sans la phrase, personne (pas même le serveur) ne peut lire les secrets.
import { h, clear, api, attempt, btn, iconBtn, formModal, confirmBox, sectionHead, card, copy, emptyState, toast, icon, ago } from '../lib.js';

const CHECK = 'glsc-vault-ok';
const AUTO_LOCK_MS = 5 * 60 * 1000;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let key = null;
let lockTimer = null;

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(k, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(k, iv, ct) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, k, unb64(ct)));
}

export async function render(root) {
  const box = h('div', {});
  root.append(sectionHead('Coffre', 'Codes Wi-Fi, clés d’API, codes de secours… chiffrés dans ton navigateur avant d’être envoyés.'), box);
  const state = await api('vault/state');
  const show = (s) => clear(box, !s.meta ? setup(show) : key ? unlocked(s, show) : locked(s, show));
  const poke = () => {
    clearTimeout(lockTimer);
    if (key) lockTimer = setTimeout(() => { key = null; toast('Coffre verrouillé (inactivité).'); api('vault/state').then(show); }, AUTO_LOCK_MS);
  };
  root.addEventListener('click', poke);
  root.addEventListener('keydown', poke);
  show(state);
  poke();
  return () => { key = null; clearTimeout(lockTimer); };
}

function setup(show) {
  return card('Créer le coffre', h('div', { class: 'stack-sm' },
    h('p', {}, 'Choisis une phrase secrète d’au moins 16 caractères (par exemple 4 mots au hasard). ', h('b', {}, 'Elle n’est jamais envoyée au serveur et ne peut pas être récupérée : '), 'si tu l’oublies, le coffre est perdu.'),
    btn('Créer le coffre', () => formModal({
      title: 'Phrase secrète du coffre',
      fields: [
        { name: 'p1', label: 'Phrase secrète', type: 'password', required: true },
        { name: 'p2', label: 'Confirme la phrase', type: 'password', required: true },
      ],
      submit: 'Créer',
      onSubmit: async (v) => {
        if (v.p1.length < 16) throw new Error('Trop courte : 16 caractères minimum.');
        if (v.p1 !== v.p2) throw new Error('Les deux saisies diffèrent.');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iterations = 600000;
        const k = await deriveKey(v.p1, salt, iterations);
        const check = await seal(k, CHECK);
        const s = await api('vault/init', { body: { salt: b64(salt), iterations, check_iv: check.iv, check_ct: check.ct } });
        key = k;
        show(s);
      },
    }), { kind: 'primary', iconName: 'lock' })), { color: 'banana' });
}

function locked(s, show) {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Phrase secrète', placeholder: 'Phrase secrète' });
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('lock-open'), h('span', {}, 'Déverrouiller'));
  const form = h('form', { class: 'unlock' }, input, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    err.hidden = true;
    try {
      const k = await deriveKey(input.value, unb64(s.meta.salt), s.meta.iterations);
      if ((await open(k, s.meta.check_iv, s.meta.check_ct)) !== CHECK) throw new Error();
      key = k;
      show(s);
    } catch {
      err.textContent = 'Phrase secrète incorrecte.';
      err.hidden = false;
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
  setTimeout(() => input.focus(), 0);
  return h('div', { class: 'stack' },
    card(`🔒 Coffre verrouillé · ${s.items.length} secret${s.items.length > 1 ? 's' : ''}`, h('div', { class: 'stack-sm' }, form, err)),
    h('p', { class: 'muted small' }, 'Phrase oubliée ? ', h('button', { class: 'link', type: 'button', onclick: () => reset(show) }, 'Effacer le coffre et recommencer')));
}

function unlocked(s, show) {
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      btn('Secret', () => itemForm(null, show), { kind: 'primary', iconName: 'plus' }),
      btn('Verrouiller', () => { key = null; show(s); }, { iconName: 'lock' })),
    s.items.length ? h('div', { class: 'stack-sm' }, s.items.map((it) => item(it, show))) : emptyState('Le coffre est vide.'));
}

function item(it, show) {
  const value = h('pre', { class: 'secret', hidden: true });
  const reveal = async () => {
    if (!value.hidden) { value.hidden = true; value.textContent = ''; return; }
    value.textContent = await open(key, it.iv, it.ct);
    value.hidden = false;
  };
  return h('article', { class: 'card secret-row' },
    h('div', { class: 'row' },
      h('b', { class: 'grow' }, icon('key-round'), ' ', it.label),
      h('small', { class: 'muted' }, ago(it.updated)),
      iconBtn('eye', 'Afficher / masquer', reveal),
      iconBtn('copy', 'Copier', async () => copy(await open(key, it.iv, it.ct), 'Secret copié')),
      iconBtn('pencil', 'Modifier', () => itemForm(it, show)),
      iconBtn('trash-2', 'Supprimer', async () => {
        if (!(await confirmBox(`Supprimer « ${it.label} » ?`))) return;
        const r = await attempt(() => api('vault/delete', { body: { id: it.id } }));
        if (r) show(r);
      })),
    value);
}

async function itemForm(it, show) {
  const current = it ? await open(key, it.iv, it.ct) : '';
  formModal({
    title: it ? 'Modifier le secret' : 'Nouveau secret',
    fields: [
      { name: 'label', label: 'Nom', value: it?.label, required: true, max: 80, placeholder: 'Wi-Fi maison, clé API…', hint: 'Le nom n’est pas chiffré : n’y mets rien de secret.' },
      { name: 'secret', label: 'Secret', type: 'textarea', value: current, rows: 4, required: true },
    ],
    onSubmit: async (v) => {
      const sealed = await seal(key, v.secret);
      show(await api('vault/save', { body: { id: it?.id, label: v.label, ...sealed } }));
    },
  });
}

function reset(show) {
  formModal({
    title: 'Effacer le coffre',
    fields: [{ name: 'confirm', label: 'Tous les secrets seront perdus. Tape EFFACER pour confirmer.', required: true }],
    submit: 'Effacer définitivement',
    onSubmit: async (v) => { key = null; show(await api('vault/reset', { body: { confirm: v.confirm } })); },
  });
}
