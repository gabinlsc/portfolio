// Script de la page — glsc.fr (old/index.html)
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Recherche instantanée ----------
  var input = document.getElementById('q');
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-section]'));
  var empty = document.getElementById('empty');
  var emptyQ = document.getElementById('empty-q');
  var count = document.getElementById('count');

  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function update() {
    var q = norm(input.value.trim());
    var total = 0;
    sections.forEach(function (sec) {
      var title = norm(sec.querySelector('h2').textContent);
      var items = sec.querySelectorAll('[data-item]');
      var shown = 0;
      items.forEach(function (it) {
        var match = !q || norm(it.textContent).indexOf(q) !== -1 || title.indexOf(q) !== -1;
        it.hidden = !match;
        if (match) shown++;
      });
      sec.hidden = shown === 0;
      sec.querySelector('[data-count]').textContent = shown;
      total += shown;
    });
    count.textContent = total;
    empty.hidden = total !== 0;
    emptyQ.textContent = input.value.trim();
  }

  input.addEventListener('input', update);
  update();
})();
