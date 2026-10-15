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
