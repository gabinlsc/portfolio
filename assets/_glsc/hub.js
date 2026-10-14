// Script de la page — glsc.fr (index.html)
(function () {
  'use strict';

  // ⚙️ Adresse de contact (un seul endroit à modifier)
  var EMAIL = 'pro@glsc.fr';

  document.getElementById('mail-link').href = 'mailto:' + EMAIL;
  document.getElementById('email-text').textContent = EMAIL;
  document.getElementById('year').textContent = new Date().getFullYear();

  // ---------- Copie de l'e-mail + bulle BD ----------
  var copyBtn = document.getElementById('copy-btn');
  var bubble = document.getElementById('copy-bubble');
  var bubbleTimer;

  function showBubble(text, ok) {
    bubble.textContent = text;
    bubble.classList.toggle('bg-mint', ok);
    bubble.classList.toggle('bg-coral', !ok);
    bubble.classList.remove('is-visible');
    void bubble.offsetWidth; // relance l'animation
    bubble.classList.add('is-visible');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { bubble.classList.remove('is-visible'); }, 2200);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  copyBtn.addEventListener('click', function () {
    var done = function () { showBubble('Copié dans le presse-papier ! ✨', true); };
    var fail = function () { showBubble('Oups, copie impossible 😅', false); };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(EMAIL).then(done, function () {
        fallbackCopy(EMAIL) ? done() : fail();
      });
    } else {
      fallbackCopy(EMAIL) ? done() : fail();
    }
  });

  // ---------- Stickers de la tech stack ----------
  var stickers = document.querySelectorAll('#stack .sticker');
  var note = document.getElementById('stack-note');

  stickers.forEach(function (s) {
    s.addEventListener('click', function () {
      var wasActive = s.getAttribute('aria-pressed') === 'true';
      stickers.forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });

      if (wasActive) {
        note.textContent = '👆 Choisis un sticker !';
        return;
      }
      s.setAttribute('aria-pressed', 'true');
      note.textContent = s.dataset.note;

      s.classList.remove('is-pop');
      void s.offsetWidth;
      s.classList.add('is-pop');
    });
    s.addEventListener('animationend', function () { s.classList.remove('is-pop'); });
  });
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
