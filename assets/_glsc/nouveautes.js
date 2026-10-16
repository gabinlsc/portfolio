// Page « Nouveautés » (games.glsc.fr/nouveautes) — /changelog.json est écrit par la sonde de admin.glsc.fr à partir des pull requests fusionnées.
// Tout le texte passe par textContent : aucun HTML construit à partir de données.
(function () {
  'use strict';
  var root = document.getElementById('news');
  var LOOK = { portfolio: 'var(--sky)', plus4: 'var(--coral)', president: 'var(--banana)', petitbac: 'var(--mint)', 'vortex-fps': 'var(--lilac)' };
  var state = { filter: '', entries: [] };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function dayLabel(ms) { return new Date(ms).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

  function draw() {
    root.textContent = '';
    var labels = {};
    state.entries.forEach(function (e) { labels[e.repo] = e.label; });
    var filters = el('div', 'news-filters');
    [['', 'Tout']].concat(Object.keys(labels).map(function (k) { return [k, labels[k]]; })).forEach(function (f) {
      var b = el('button', 'pbtn' + (state.filter === f[0] ? ' primary' : ''), f[1]);
      b.type = 'button';
      b.addEventListener('click', function () { state.filter = f[0]; draw(); });
      filters.append(b);
    });
    root.append(filters);

    var list = state.entries.filter(function (e) { return !state.filter || e.repo === state.filter; });
    if (!list.length) { root.append(el('p', 'muted', 'Rien à signaler pour l’instant.')); return; }
    var days = [], byDay = {};
    list.forEach(function (e) {
      var k = new Date(e.at * 1000).toDateString();
      if (!byDay[k]) { byDay[k] = []; days.push(k); }
      byDay[k].push(e);
    });
    days.forEach(function (k) {
      var sec = el('section', 'news-day');
      sec.append(el('h2', null, dayLabel(byDay[k][0].at * 1000)));
      byDay[k].forEach(function (e) {
        var a = el('a', 'news-item');
        a.href = e.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        var tag = el('span', 'news-tag', e.label); tag.style.background = LOOK[e.repo] || '#fff';
        a.append(tag, el('span', 'news-title', e.title), el('span', 'news-meta', 'PR n° ' + e.number + ' · voir le détail'));
        sec.append(a);
      });
      root.append(sec);
    });
  }

  document.getElementById('year').textContent = new Date().getFullYear();
  fetch('/changelog.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.entries) { root.textContent = ''; root.append(el('p', 'muted', 'Le journal arrive bientôt.')); return; }
    state.entries = d.entries;
    draw();
  }).catch(function () { root.textContent = ''; root.append(el('p', 'muted', 'Le journal est momentanément indisponible.')); });
})();
