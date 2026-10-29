// Coquille de admin.glsc.fr : menu, navigation par #ancre, chargement des modules à la demande.
import { h, clear, icon, toast } from './lib.js';

// icônes du menu : wallet file-text briefcase layout-dashboard kanban sticky-note graduation-cap chart-column eye link activity shield gamepad-2 users github upload lock wrench settings
const NAV = [
  { group: null, items: [['dashboard', 'Accueil', 'layout-dashboard']] },
  { group: 'Organisation', items: [['kanban', 'Kanban', 'kanban'], ['notes', 'Notes & liens', 'sticky-note'], ['school', 'Alternance', 'graduation-cap']] },
  { group: 'Sites & stats', items: [['traffic', 'Trafic', 'chart-column'], ['studio', 'StudioGLSC', 'briefcase'], ['billing', 'Devis & factures', 'file-text'], ['accounting', 'Compta', 'wallet'], ['cvstats', 'Stats CV & Projets', 'eye'], ['short', 'Liens courts', 'link']] },
  { group: 'Serveur', items: [['health', 'Santé', 'activity'], ['security', 'Sécurité', 'shield'], ['games', 'Jeux en direct', 'gamepad-2'], ['players', 'Joueurs', 'users'], ['github', 'GitHub & déploiements', 'github']] },
  { group: 'Outils', items: [['files', 'Fichiers', 'upload'], ['vault', 'Coffre', 'lock'], ['tools', 'Mini-outils', 'wrench']] },
  { group: null, items: [['settings', 'Réglages', 'settings']] },
];

// gst.glsc.fr : espace StudioGLSC (mêmes pages et même connexion, menu réduit à l'activité du studio)
const GST = document.querySelector('meta[name="glsc-instance"]')?.content === 'gst';
const NAV_GST = [
  { group: null, items: [['home', 'Accueil', 'layout-dashboard']] },
  { group: 'Activité', items: [['studio', 'Demandes & projets', 'briefcase']] },
  { group: 'Gestion', items: [['billing', 'Devis & factures', 'file-text'], ['accounting', 'Compta', 'wallet']] },
];
const LINKS = GST ? [['studio.glsc.fr', 'https://studio.glsc.fr'], ['Portail pro', 'https://pro.glsc.fr']] : [['Espace StudioGLSC', 'https://gst.glsc.fr']];
const HOME = GST ? 'home' : 'dashboard';
const SITE = GST ? 'StudioGLSC' : 'Admin GLSC';
const NAV_ACTIVE = GST ? NAV_GST : NAV;
const PAGES = Object.fromEntries(NAV_ACTIVE.flatMap((g) => g.items.map(([id, label, ic]) => [id, { label, ic }])));

const app = document.getElementById('app');
let cleanup = null;
let navOpen = false;

function shell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Menu principal' },
    NAV_ACTIVE.map((g) => h('div', { class: 'nav-group' },
      g.group ? h('p', { class: 'nav-title' }, g.group) : null,
      g.items.map(([id, label, ic]) => h('a', { href: '#/' + id, class: 'nav-link', dataset: { page: id } }, icon(ic), h('span', {}, label))))),
    h('div', { class: 'nav-group' }, h('p', { class: 'nav-title' }, 'Liens'),
      LINKS.map(([label, href]) => h('a', { href, class: 'nav-link nav-ext', target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', {}, label)))));

  const logout = h('button', { class: 'btn btn-ghost nav-logout', type: 'button', onclick: doLogout }, icon('log-out'), h('span', {}, 'Déconnexion'));
  const side = h('aside', { class: 'side', id: 'side' },
    h('a', { class: 'brand', href: '#/' + HOME }, h('span', { class: 'brand-logo', 'aria-hidden': 'true' }, GST ? 'S' : 'G'), GST ? h('span', {}, 'StudioGLSC', h('small', {}, 'Espace pro')) : h('span', {}, 'Admin', h('small', {}, 'glsc.fr'))),
    nav, logout);

  const burger = h('button', { class: 'icon-btn burger', type: 'button', 'aria-label': 'Ouvrir le menu', 'aria-controls': 'side', 'aria-expanded': 'false',
    onclick: () => toggleNav() }, icon('menu'));
  const top = h('header', { class: 'topbar' }, burger, h('a', { class: 'brand brand-sm', href: '#/' + HOME }, h('span', { class: 'brand-logo', 'aria-hidden': 'true' }, GST ? 'S' : 'G'), GST ? 'StudioGLSC' : 'Admin'));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const scrim = h('div', { class: 'scrim', onclick: () => toggleNav(false) });
  clear(app, top, side, scrim, main);
  return { main, burger };
}

const ui = shell();

function toggleNav(force) {
  navOpen = force ?? !navOpen;
  document.body.classList.toggle('nav-open', navOpen);
  ui.burger.setAttribute('aria-expanded', String(navOpen));
}

async function doLogout() {
  try {
    await fetch('/logout', { method: 'POST', headers: { 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content } });
  } finally {
    location.href = '/';
  }
}

async function route() {
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || HOME;
  const page = PAGES[id] ? id : HOME;
  toggleNav(false);
  document.querySelectorAll('.nav-link').forEach((a) => a.toggleAttribute('aria-current', a.dataset.page === page));
  document.title = `${PAGES[page].label} · ${SITE}`;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  clear(ui.main, h('div', { class: 'loading' }, 'Chargement…'));
  try {
    const mod = await import(`./modules/${GST && page === 'home' ? 'gst-home' : page}.js`);
    clear(ui.main);
    cleanup = await mod.render(ui.main);
  } catch (e) {
    console.error(e);
    clear(ui.main, h('div', { class: 'card c-coral' }, h('h2', {}, 'Oups'), h('p', {}, e.message || 'Impossible de charger cette page.')));
  }
  ui.main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || 'Erreur inattendue', 'bad'));
route();
