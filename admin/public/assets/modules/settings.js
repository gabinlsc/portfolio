// Réglages : alertes Discord, état de la 2FA et journal de connexion.
import { h, clear, api, attempt, sectionHead, card, btn, pill, dateTimeFr } from '../lib.js';

export async function render(root) {
  const box = h('div', {});
  root.append(sectionHead('Réglages', 'Alertes et sécurité du compte.'), box);
  const show = (s) => clear(box, view(s, show));
  show(await api('settings/get'));
}

function view(s, show) {
  const hook = h('input', { class: 'input', type: 'url', placeholder: s.discord || 'https://discord.com/api/webhooks/…', 'aria-label': 'Webhook Discord', autocomplete: 'off' });
  const toggles = s.alerts.map((a) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: a.on, onchange: async (e) => {
      const r = await attempt(() => api('settings/save', { body: { alerts: { [a.key]: e.target.checked } } }), 'Enregistré');
      if (!r) e.target.checked = !e.target.checked;
    } }), h('span', {}, a.label)));

  return h('div', { class: 'grid grid-2' },
    card('Alertes Discord', h('div', { class: 'stack-sm' },
      h('p', { class: 'muted small' }, 'Sur Discord : Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l’URL.'),
      s.discord ? h('p', {}, pill('configuré', 'mint'), ' ', h('span', { class: 'mono small' }, s.discord)) : h('p', {}, pill('pas configuré', 'banana')),
      h('div', { class: 'row' }, hook,
        btn('Enregistrer', async () => {
          const r = await attempt(() => api('settings/save', { body: { discord: hook.value.trim() } }), 'Webhook enregistré');
          if (r) show(r);
        }, { kind: 'primary' })),
      h('div', { class: 'row' },
        btn('Envoyer un test', async () => { await attempt(() => api('settings/test-discord', { body: {} }), (r) => r.message); }, { iconName: 'send' }),
        btn('Récap des 7 derniers jours', async () => {
          await attempt(() => api('settings/recap', { body: { period: '7j' } }), (r) => r.message);
        }, { iconName: 'chart-column', title: 'Envoie tout de suite le récap sur Discord (aussi : « glsc-recap » sur le serveur)' }),
        s.discord ? btn('Retirer', async () => {
          const r = await attempt(() => api('settings/save', { body: { discord: '' } }), 'Webhook retiré');
          if (r) show(r);
        }, { kind: 'danger' }) : null),
      h('h3', {}, 'Me prévenir quand…'),
      h('div', { class: 'stack-xs' }, toggles))),
    backupCard(s.backup, show),
    card('Connexion & 2FA', h('div', { class: 'stack-sm' },
      h('p', {}, 'Codes de secours restants : ', pill(String(s.recovery_left), s.recovery_left > 2 ? 'mint' : 'coral')),
      h('p', { class: 'muted small' }, 'Pour changer le mot de passe, refaire la 2FA (nouveau téléphone) ou régénérer les codes de secours, connecte-toi en SSH au serveur et lance :'),
      h('pre', { class: 'code' }, 'glsc-admin-setup --password\nglsc-admin-setup --2fa\nglsc-admin-setup --recovery'),
      h('p', { class: 'muted small' }, 'Session : déconnexion automatique après 2 h sans activité (12 h maximum). 5 essais ratés bloquent la connexion 15 min.'))),
    card('Journal de connexion', h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Quand', 'Événement', 'IP', 'Navigateur'].map((c) => h('th', {}, c)))),
      h('tbody', {}, s.log.map((l) => h('tr', {}, h('td', { class: 'nowrap' }, dateTimeFr(l.at)), h('td', {}, l.event), h('td', { class: 'mono' }, l.ip),
        h('td', { class: 'ellipsis small' }, l.ua)))))), { cls: 'span-2' }));
}


function backupCard(b, show) {
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko');
  const ago = (t) => dateTimeFr(t);
  let body;
  if (!b || !b.configured) {
    body = [
      h('p', {}, pill('pas activées', 'coral')),
      h('p', { class: 'muted small' }, 'Chaque nuit, la base de l’admin, les classements, les identifiants, la config nginx et les certificats sont archivés puis chiffrés avec une clé publique : le serveur ne peut pas relire ses propres sauvegardes. Pour activer, sur le serveur :'),
      h('pre', { class: 'code' }, 'glsc-backup-setup\nglsc-backup-setup --rclone mon-stockage:glsc   # envoi hors du serveur'),
    ];
  } else {
    body = [
      h('p', {}, b.ok ? pill('en place', 'mint') : pill('à vérifier', 'coral'), ' ',
        b.last_ok ? h('span', { class: 'muted small' }, 'dernière réussie : ', ago(b.last_ok)) : null),
      b.name ? h('p', { class: 'small' }, h('span', { class: 'mono' }, b.name), ' · ', size(b.size), ' · ', String(b.local), ' gardée(s) sur le serveur') : null,
      b.offsite
        ? h('p', {}, pill('copie hors du serveur : ' + b.offsite, 'mint'))
        : h('p', {}, pill('aucune copie hors du serveur', 'banana'), ' ', h('span', { class: 'muted small' }, 'si le VPS disparaît, les archives disparaissent avec : glsc-backup-setup --rclone … ou --discord')),
      b.error ? h('p', { class: 'small error' }, b.error) : null,
    ];
  }
  const run = (b && b.configured) ? btn('Sauvegarder maintenant', async () => {
    await attempt(() => api('settings/backup', { body: {} }), (r) => r.message);
  }, { iconName: 'lock', title: 'Lance une sauvegarde tout de suite' }) : null;
  return card('Sauvegardes chiffrées', h('div', { class: 'stack-sm' }, ...body, run));
}
