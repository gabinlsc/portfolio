// Page « Mon profil » (games.glsc.fr/profil) — API : /api/profile/* (service « profiles », cookie de session HttpOnly).
// Tout le texte passe par textContent : aucun HTML construit à partir de données.
(function () {
  'use strict';
  var root = document.getElementById('profil');
  var GAMES = { uno: '+4', president: 'Le Président', petitbac: 'Petit Bac', vortex: 'Vortex' };
  var LOOK = { uno: ['c-coral', '🃏'], president: ['c-banana', '👑'], petitbac: ['c-mint', '✏️'], vortex: ['c-lilac', '🎯'] };
  var state = { profile: null, fiches: null, achievements: [], busy: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function n(x) { return Number(x || 0).toLocaleString('fr-FR'); }
  function dateFr(ms) { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }

  function api(path, body) {
    var opts = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch('/api/profile' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Erreur (' + r.status + ')');
        return j;
      });
    });
  }

  function msg(text, err) { var m = el('p', 'msg' + (err ? ' err' : ''), text); m.setAttribute('role', err ? 'alert' : 'status'); return m; }
  function button(label, cls, onClick) {
    var b = el('button', 'pbtn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true; b.disabled = true;
      Promise.resolve(onClick(b)).catch(function () { }).then(function () { state.busy = false; b.disabled = false; });
    });
    return b;
  }
  function field(label, attrs) {
    var wrap = el('label', null, label);
    var input = el('input', 'field');
    Object.keys(attrs).forEach(function (k) { input.setAttribute(k, attrs[k]); });
    wrap.append(input);
    return { wrap: wrap, input: input };
  }
  function show(nodes) { root.textContent = ''; nodes.forEach(function (x) { root.append(x); }); }
  function fail(box, e) { var old = box.querySelector('.msg.err'); if (old) old.remove(); box.append(msg(e.message || 'Erreur', true)); }

  // ---------------------------------------------------------------- invité : créer ou récupérer
  function viewGuest() {
    var createBox = el('div', 'box c-banana');
    createBox.append(el('h3', null, 'Créer mon profil'),
      el('p', null, 'Ton pseudo est réservé : personne d’autre ne peut le prendre. Tes parties, tes stats et tes succès te suivent d’un jeu à l’autre.'));
    var name = field('Pseudo (2 à 16 caractères)', { type: 'text', maxlength: '16', minlength: '2', autocomplete: 'nickname', required: 'required' });
    createBox.append(name.wrap, button('Créer mon profil', 'primary', function () {
      return api('/create', { name: name.input.value }).then(function (r) { state.profile = r.profile; viewCode(r.recoveryCode, true); }, function (e) { fail(createBox, e); });
    }));

    var recoverBox = el('div', 'box c-sky');
    recoverBox.append(el('h3', null, 'J’ai déjà un profil'),
      el('p', null, 'Nouvel appareil, navigateur vidé ? Entre ton code de récupération.'));
    var code = field('Code de récupération', { type: 'text', placeholder: 'GLSC-XXXX-XXXX-…', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
    recoverBox.append(code.wrap, button('Me reconnecter', null, function () {
      return api('/recover', { code: code.input.value }).then(function (r) { state.profile = r.profile; load(); }, function (e) { fail(recoverBox, e); });
    }));

    var grid = el('div', 'profil-grid');
    grid.append(createBox, recoverBox);
    show([grid, el('p', 'muted', 'Sans profil, tu peux jouer comme invité avec n’importe quel pseudo non réservé. Le profil garde un cookie sur ton navigateur (identifiant de session, rien d’autre) et le serveur ne conserve que son empreinte.')]);
  }

  // ---------------------------------------------------------------- code de récupération (affiché une seule fois)
  function viewCode(code, first) {
    var box = el('div', 'box c-mint');
    box.append(el('h3', null, first ? 'Profil créé. Note ton code !' : 'Ton nouveau code'),
      el('p', null, 'Ce code est affiché une seule fois. Il te permet de te reconnecter sur un autre appareil ou si tu vides ton navigateur. Le serveur n’en garde qu’une empreinte : nous ne pourrons pas te le redonner.'),
      el('div', 'code', code));
    var ok = el('input'); ok.type = 'checkbox'; ok.id = 'noted';
    var lab = el('label'); lab.append(ok, ' Je l’ai noté dans un endroit sûr (gestionnaire de mots de passe, papier…).');
    var go = button('Continuer', 'primary', function () { return load(); });
    go.disabled = true;
    ok.addEventListener('change', function () { go.disabled = !ok.checked; });
    var row = el('div', 'btn-row');
    row.append(button('Copier', null, function (b) {
      var done = function () { b.textContent = 'Copié ✓'; setTimeout(function () { b.textContent = 'Copier'; }, 1500); };
      return (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(done, function () { });
    }), button('Télécharger (.txt)', null, function () {
      var a = el('a'); a.href = URL.createObjectURL(new Blob(['Code de récupération glsc.fr : ' + code + '\n'], { type: 'text/plain' }));
      a.download = 'glsc-code-de-recuperation.txt'; document.body.append(a); a.click(); a.remove();
    }));
    box.append(row, lab, go);
    show([box]);
  }

  // ---------------------------------------------------------------- profil connecté
  function viewProfile() {
    var p = state.profile;
    var fiche = state.fiches && state.fiches[p.pid];
    var totals = { played: 0, wins: 0 };
    Object.keys((fiche && fiche.games) || {}).forEach(function (g) {
      if (!GAMES[g]) return;
      totals.played += fiche.games[g].played; totals.wins += fiche.games[g].wins;
    });
    var head = el('div', 'box hero-card c-banana');
    var info = el('div');
    info.append(el('p', 'since', 'Profil créé le ' + dateFr(p.createdAt)), el('p', 'who-name', p.name));
    var chips = el('div', 'chips');
    chips.append(el('span', 'pill', '🎮 ' + n(totals.played) + ' partie' + (totals.played > 1 ? 's' : '')),
      el('span', 'pill', '🏆 ' + n(totals.wins) + ' victoire' + (totals.wins > 1 ? 's' : '')),
      el('span', 'pill', '⭐ ' + n(fiche ? fiche.achievements.length : 0) + ' succès'));
    info.append(chips);
    head.append(el('div', 'avatar', p.name.slice(0, 1).toUpperCase()), info);

    var stats = el('div', 'box c-sky');
    stats.append(el('h3', null, 'Mes statistiques'));
    var games = fiche && Object.keys(fiche.games).filter(function (g) { return GAMES[g]; });
    if (!games || !games.length) {
      stats.append(el('p', null, 'Rien pour l’instant : lance une partie en étant connecté, les résultats arrivent ici dans la minute qui suit.'));
    } else {
      var tiles = el('div', 'tiles');
      games.forEach(function (g) {
        var s = fiche.games[g];
        var look = LOOK[g] || ['c-banana', '🎮'];
        var tile = el('div', 'tile ' + look[0]);
        var detail = g === 'vortex' ? n(s.kills) + ' élim. · ' + n(s.deaths) + ' morts' : g === 'president' ? n(s.president) + ' × président' : n(s.wins) + ' victoire' + (s.wins > 1 ? 's' : '');
        tile.append(el('span', 't-name', look[1] + ' ' + GAMES[g]), el('span', 't-big', n(s.played)),
          el('span', 't-sub', (g === 'president' || g === 'vortex' ? 'manche' : 'partie') + (s.played > 1 ? 's' : '') + ' jouée' + (s.played > 1 ? 's' : '')),
          el('span', 't-sub', detail));
        tiles.append(tile);
      });
      stats.append(tiles);
    }

    var ach = el('div', 'box c-lilac');
    ach.append(el('h3', null, 'Mes succès'));
    var got = fiche ? fiche.achievements : [];
    if (!got.length) ach.append(el('p', null, 'Aucun succès pour l’instant. Ça viendra vite.'));
    else {
      var list = el('div', 'ach-grid');
      got.forEach(function (x) {
        var a = state.achievements.filter(function (d) { return d.id === x.id; })[0];
        if (!a) return;
        var card = el('div', 'ach got');
        card.append(el('span', 'ach-emoji', a.emoji));
        var tx = el('div', 'ach-text'); tx.append(el('strong', null, a.name), el('span', 'ach-desc', a.desc), el('span', 'ach-who', 'Débloqué le ' + dateFr(x.at * 1000)));
        card.append(tx); list.append(card);
      });
      ach.append(list);
    }

    // gestion
    var manage = el('div', 'box c-mint');
    manage.append(el('h3', null, 'Mon compte'));
    var rn = field('Changer de pseudo', { type: 'text', maxlength: '16', minlength: '2', autocomplete: 'off' });
    var wait = p.canRenameAt > Date.now();
    manage.append(rn.wrap);
    var rnBtn = button('Renommer', null, function () {
      return api('/rename', { name: rn.input.value }).then(function () { return load(); }, function (e) { fail(manage, e); });
    });
    if (wait) { rnBtn.disabled = true; rn.input.disabled = true; manage.append(el('p', 'muted', 'Tu pourras changer de pseudo à partir du ' + dateFr(p.canRenameAt) + '. Tes stats te suivent.')); }
    var row1 = el('div', 'btn-row');
    row1.append(rnBtn, button('Nouveau code de récupération', null, function () {
      if (!confirm('L’ancien code ne fonctionnera plus. Continuer ?')) return;
      return api('/new-code', {}).then(function (r) { viewCode(r.recoveryCode, false); }, function (e) { fail(manage, e); });
    }));
    var row2 = el('div', 'btn-row');
    row2.append(button('Me déconnecter', null, function () { return api('/logout', {}).then(function () { return load(); }); }),
      button('Me déconnecter partout', null, function () {
        return api('/logout-all', {}).then(function () { return load(); }, function (e) { fail(manage, e); });
      }));
    manage.append(row1, row2);

    var danger = el('div', 'box c-coral');
    danger.append(el('h3', null, 'Supprimer mon profil'),
      el('p', null, 'Efface ton profil, tes sessions et ton code, et retire tes parties des classements et de ta fiche. Définitif.'));
    var conf = field('Tape ton pseudo (« ' + p.name + ' ») pour confirmer', { type: 'text', autocomplete: 'off' });
    danger.append(conf.wrap, button('Supprimer définitivement', 'danger', function () {
      return api('/delete', { confirm: conf.input.value }).then(function () { return load(); }, function (e) { fail(danger, e); });
    }));

    var grid = el('div', 'profil-grid');
    grid.append(stats, ach, manage, danger);
    show([head, grid]);
  }

  // ---------------------------------------------------------------- chargement
  function load() {
    return Promise.all([
      api('/me'),
      fetch('/players.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch('/leaderboard.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      state.profile = res[0].profile;
      state.fiches = res[1] && res[1].players;
      state.achievements = (res[2] && res[2].achievements) || [];
      if (state.profile) viewProfile(); else viewGuest();
    }, function (e) { show([msg('Impossible de joindre le service de profils : ' + e.message, true)]); });
  }

  document.getElementById('year').textContent = new Date().getFullYear();
  load();
})();
