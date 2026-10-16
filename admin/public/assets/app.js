// Coquille de admin.glsc.fr : menu, navigation par #ancre, chargement des modules à la demande.
import { h, clear, icon, toast } from './lib.js';

// icônes du menu : layout-dashboard kanban sticky-note graduation-cap chart-column eye link activity shield gamepad-2 users github upload lock wrench settings
const NAV = [
  { group: null, items: [['dashboard', 'Accueil', 'layout-dashboard']] },
  { group: 'Organisation', items: [['kanban', 'Kanban', 'kanban'], ['notes', 'Notes & liens', 'sticky-note'], ['school', 'Alternance', 'graduation-cap']] },
  { group: 'Sites & stats', items: [['traffic', 'Trafic', 'chart-column'], ['cvstats', 'Stats CV & Projets', 'eye'], ['short', 'Liens courts', 'link']] },
  { group: 'Serveur', items: [['health', 'Santé', 'activity'], ['security', 'Sécurité', 'shield'], ['games', 'Jeux en direct', 'gamepad-2'], ['players', 'Joueurs', 'users'], ['github', 'GitHub & déploiements', 'github']] },
  { group: 'Outils', items: [['files', 'Fichiers', 'upload'], ['vault', 'Coffre', 'lock'], ['tools', 'Mini-outils', 'wrench']] },
  { group: null, items: [['settings', 'Réglages', 'settings']] },
];
const PAGES = Object.fromEntries(NAV.flatMap((g) => g.items.map(([id, label, ic]) => [id, { label, ic }])));

const app = document.getElementById('app');
let cleanup = null;
let navOpen = false;

function shell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Menu principal' },
    NAV.map((g) => h('div', { class: 'nav-group' },
      g.group ? h('p', { class: 'nav-title' }, g.group) : null,
      g.items.map(([id, label, ic]) => h('a', { href: '#/' + id, class: 'nav-link', dataset: { page: id } }, icon(ic), h('span', {}, label))))));

  const logout = h('button', { class: 'btn btn-ghost nav-logout', type: 'button', onclick: doLogout }, icon('log-out'), h('span', {}, 'Déconnexion'));
  const side = h('aside', { class: 'side', id: 'side' },
    h('a', { class: 'brand', href: '#/dashboard' }, h('span', { class: 'brand-logo', 'aria-hidden': 'true' }, 'G'), h('span', {}, 'Admin', h('small', {}, 'glsc.fr'))),
    nav, logout);

  const burger = h('button', { class: 'icon-btn burger', type: 'button', 'aria-label': 'Ouvrir le menu', 'aria-controls': 'side', 'aria-expanded': 'false',
    onclick: () => toggleNav() }, icon('menu'));
  const top = h('header', { class: 'topbar' }, burger, h('a', { class: 'brand brand-sm', href: '#/dashboard' }, h('span', { class: 'brand-logo', 'aria-hidden': 'true' }, 'G'), 'Admin'));
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
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
  const page = PAGES[id] ? id : 'dashboard';
  toggleNav(false);
  document.querySelectorAll('.nav-link').forEach((a) => a.toggleAttribute('aria-current', a.dataset.page === page));
  document.title = `${PAGES[page].label} · Admin GLSC`;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  clear(ui.main, h('div', { class: 'loading' }, 'Chargement…'));
  try {
    const mod = await import(`./modules/${page}.js`);
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
