// Script de la page — glsc.fr (projets/index.html)
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Filtres + recherche ----------
  var cards = Array.prototype.slice.call(document.querySelectorAll('.proj'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var input = document.getElementById('q');
  var empty = document.getElementById('empty');
  var current = 'all';

  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function update() {
    var q = norm(input.value.trim());
    var shown = 0;
    cards.forEach(function (c) {
      var okCat = current === 'all' || c.dataset.cat === current;
      var okQ = !q || norm(c.dataset.search).indexOf(q) !== -1;
      c.hidden = !(okCat && okQ);
      if (!c.hidden) shown++;
    });
    empty.hidden = shown !== 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      current = chip.dataset.filter;
      chips.forEach(function (o) {
        var on = o === chip;
        o.classList.toggle('is-on', on);
        o.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      update();
    });
  });
  input.addEventListener('input', update);
})();

// Mesure d'audience maison (sans cookie) : un clic important = une requête vers /_glsc/b.gif?e=…, comptée par admin.glsc.fr.
(function () {
  'use strict';
  function track(e) {
    try { fetch('/_glsc/b.gif?e=' + encodeURIComponent(e), { keepalive: true, cache: 'no-store' }).catch(function () {}); } catch (err) { /* rien */ }
  }
  window.glscTrack = track;
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('a, button') : null;
    if (!el) return;
    var e = el.getAttribute('data-track') || (function (a) {
      var card = a.closest('.proj');
      if (!card || a.tagName !== 'A') return '';
      var title = (card.querySelector('h3') || {}).textContent || '';
      title = title.split('·')[0].replace(/[^\w\u00C0-\u017F -]/g, '').trim().slice(0, 30);
      return 'project:' + title + (a.classList.contains('act-play') ? ' (jouer)' : ' (code)');
    })(el);
    if (e) track(e);
  });
})();

// Activité GitHub en direct : /github.json est écrit par la sonde de admin.glsc.fr (toutes les 15 min).
(function () {
  'use strict';
  var COLORS = { TypeScript: '#3178c6', JavaScript: '#f1e05a', Vue: '#41b883', Python: '#3572A5', Rust: '#dea584', 'C++': '#f34b7d',
    C: '#555555', Java: '#b07219', CSS: '#563d7c', SCSS: '#c6538c', HTML: '#e34c26', Shell: '#89e051', PHP: '#4F5D95', CMake: '#DA3434',
    Dockerfile: '#384d54', Go: '#00ADD8', Makefile: '#427819', Batchfile: '#C1F12E' };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ago(t) {
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < 3600) return 'il y a ' + Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
    var d = Math.round(s / 86400);
    if (d < 31) return 'il y a ' + d + ' j';
    var m = Math.round(d / 30.4);
    return m < 12 ? 'il y a ' + m + ' mois' : 'il y a plus d’un an';
  }
  function heat(t) {
    var d = (Date.now() / 1000 - t) / 86400;
    return d < 14 ? 'hot' : d < 60 ? 'warm' : 'cold';
  }
  function repoOf(card) {
    var a = card.querySelector('a[href^="https://github.com/gabinlsc/"]');
    return a ? a.getAttribute('href').split('/')[4] : null;
  }

  function cardStrip(r) {
    var box = el('div', 'gh');
    var head = el('p', 'gh-head');
    head.append(el('span', 'gh-dot gh-' + heat(r.pushed)), 'Mis à jour ' + ago(r.pushed));
    if (r.commits30) head.append(el('span', 'gh-count', r.commits30 + (r.commits30 > 1 ? ' commits' : ' commit') + ' en 30 j'));
    box.append(head);
    if (r.languages.length) {
      var bar = el('div', 'gh-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', 'Langages : ' + r.languages.map(function (l) { return l[0] + ' ' + l[1] + ' %'; }).join(', '));
      var legend = el('p', 'gh-legend');
      r.languages.forEach(function (l, i) {
        var seg = el('span');
        seg.style.width = l[1] + '%';
        seg.style.background = COLORS[l[0]] || '#C3A6FF';
        bar.append(seg);
        if (i < 3 && l[1] >= 1) {
          var item = el('span', 'gh-lang');
          var sw = el('i'); sw.style.background = COLORS[l[0]] || '#C3A6FF';
          item.append(sw, l[0] + ' ' + String(Math.round(l[1])) + ' %');
          legend.append(item);
        }
      });
      box.append(bar, legend);
    }
    if (r.last[0]) {
      var c = el('a', 'gh-commit');
      c.href = r.url + '/commit/' + r.last[0].sha;
      c.target = '_blank'; c.rel = 'noopener noreferrer';
      c.title = 'Dernier commit, ' + ago(r.last[0].at);
      c.append(el('code', null, r.last[0].sha), ' ' + r.last[0].message);
      box.append(c);
    }
    return box;
  }

  function feed(data, byName) {
    var host = document.getElementById('gh-feed');
    if (!host || !data.recent.length) return;
    var list = el('ol', 'gh-feed-list');
    data.recent.forEach(function (x) {
      var li = el('li');
      var a = el('a');
      a.href = byName[x.repo].url + '/commit/' + x.sha;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.append(el('strong', null, x.repo), el('span', 'gh-msg', x.message), el('span', 'gh-when', ago(x.at)));
      li.append(a);
      list.append(li);
    });
    host.querySelector('.gh-feed-body').append(list);
    host.hidden = false;
  }

  fetch('/github.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
    if (!data || !Array.isArray(data.repos)) return;
    var byName = {};
    data.repos.forEach(function (r) { byName[r.name.toLowerCase()] = r; byName[r.name] = r; });
    document.querySelectorAll('.proj').forEach(function (card) {
      var name = repoOf(card), r = name && byName[name.toLowerCase()];
      var stack = card.querySelector('.stack');
      if (r && stack) stack.before(cardStrip(r));
    });
    feed(data, byName);
  }).catch(function () { /* pas de données : la page reste telle quelle */ });
})();
