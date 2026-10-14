// Script de la page — glsc.fr (cv/index.html)
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();
  document.getElementById('print-btn').addEventListener('click', function () { window.print(); });
})();

// Photo absente : on garde le monogramme « GL » affiché derrière.
(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('img[data-fallback]'), function (img) {
    function drop() { img.remove(); }
    if (img.complete && img.naturalWidth === 0) drop();
    else img.addEventListener('error', drop);
  });
})();

// Coordonnées de la version imprimée : absentes du HTML, reconstituées ici
// pour ne pas être aspirées par les robots qui lisent le code source.
(function () {
  'use strict';
  var D = { phone: '=QjMgQDNgAjMgcjNgcDM', mail: '==QbvNmLslWYtdGQulmYhdGdh92YzVGb', birth: '==QOy0SMx0iNwAjM' };
  function dec(s) { return atob(s.split('').reverse().join('')); }

  var b = dec(D.birth).split('-').map(Number);
  var now = new Date();
  var age = now.getFullYear() - b[0] - ((now.getMonth() + 1 < b[1] || (now.getMonth() + 1 === b[1] && now.getDate() < b[2])) ? 1 : 0);
  var values = {
    phone: dec(D.phone),
    mail: dec(D.mail),
    birth: ('0' + b[2]).slice(-2) + '/' + ('0' + b[1]).slice(-2) + '/' + b[0] + ' (' + age + ' ans)'
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-p]'), function (el) {
    el.textContent = values[el.getAttribute('data-p')] || '';
  });
})();
