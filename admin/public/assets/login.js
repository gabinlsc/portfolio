// Page de connexion : envoi en JSON avec le jeton CSRF, message d'erreur clair.
(function () {
  'use strict';
  var form = document.getElementById('login');
  if (!form) return;
  var error = document.getElementById('login-error');
  var token = document.querySelector('meta[name="csrf-token"]').content;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button');
    btn.disabled = true;
    error.hidden = true;
    fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ password: form.password.value, code: form.code.value }),
      credentials: 'same-origin'
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) { location.reload(); return; }
        error.textContent = res.d.error || 'Connexion refusée.';
        error.hidden = false;
        form.code.value = '';
        form.code.focus();
      })
      .catch(function () { error.textContent = 'Serveur injoignable.'; error.hidden = false; })
      .then(function () { btn.disabled = false; });
  });
})();
