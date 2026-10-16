// Page « Mon profil » (games.glsc.fr/profil) — API : /api/profile/* (service « profiles », cookie de session HttpOnly).
// Tout le texte passe par textContent : aucun HTML construit à partir de données.
(function () {
  'use strict';
  var root = document.getElementById('profil');
  var GAMES = { uno: '+4', president: 'Le Président', petitbac: 'Petit Bac', vortex: 'Vortex' };
  var LOOK = { uno: ['c-coral', '🃏'], president: ['c-banana', '👑'], petitbac: ['c-mint', '✏️'], vortex: ['c-lilac', '🎯'] };
  var state = { profile: null, fiches: null, achievements: [], daily: null, crews: [], openCrew: null, busy: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function monthName(label) { var q = label.split('-'); return MONTHS[Number(q[1]) - 1] + ' ' + q[0]; }
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
    var titles = (fiche && fiche.titles) || [];
    if (titles.length) {
      var tl = el('div', 'chips');
      titles.forEach(function (t) { tl.append(el('span', 'pill', '🏅 Champion ' + (GAMES[t.game] || t.game) + ' · ' + monthName(t.month))); });
      info.append(tl);
    }
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

    // défi du jour
    var dailyBox = el('div', 'box c-peach');
    dailyBox.append(el('h3', null, 'Défi du jour'));
    var dl = fiche && fiche.daily;
    if (!state.daily) dailyBox.append(el('p', null, 'Le défi du jour apparaît ici dans un instant.'));
    else {
      dailyBox.append(el('p', null, state.daily.text + '.'));
      var prog = Math.min(dl ? dl.progress : 0, state.daily.goal);
      var bar = el('div', 'meter'); var fill = el('div', 'meter-fill'); fill.style.width = (prog / state.daily.goal * 100) + '%'; bar.append(fill);
      dailyBox.append(bar, el('p', 'muted', dl && dl.done ? '✅ Défi relevé aujourd’hui !' : prog + ' / ' + state.daily.goal));
      var dchips = el('div', 'chips');
      dchips.append(el('span', 'pill', '🔥 ' + (dl ? dl.streak : 0) + ' jour' + (dl && dl.streak > 1 ? 's' : '') + ' d’affilée'),
        el('span', 'pill', '🏆 record : ' + (dl ? dl.best : 0)));
      dailyBox.append(dchips);
    }

    // historique
    var histBox = el('div', 'box c-sky');
    histBox.append(el('h3', null, 'Mes dernières parties'));
    var hist = (fiche && fiche.history) || [];
    if (!hist.length) histBox.append(el('p', null, 'Aucune partie enregistrée pour l’instant.'));
    else {
      var ul = el('ul', 'history');
      hist.forEach(function (h) {
        var look = LOOK[h.game] || ['c-banana', '🎮'];
        var li = el('li', 'hist-row');
        li.append(el('span', 'hist-emoji', look[1]),
          el('span', 'hist-main', (GAMES[h.game] || h.game) + ' · ' + (h.won ? '🥇 victoire' : h.rank + (h.rank === 1 ? 'er' : 'e') + ' sur ' + h.n)),
          el('span', 'hist-meta', dateFr(h.t * 1000) + (h.with.length ? ' · avec ' + h.with.join(', ') : '')));
        ul.append(li);
      });
      histBox.append(ul);
    }

    // rivalités
    var rivBox = el('div', 'box c-coral');
    rivBox.append(el('h3', null, 'Mes rivalités'));
    var rv = (fiche && fiche.rivals) || {};
    if (!rv.nemesis && !rv.victim) rivBox.append(el('p', null, 'Joue au moins 3 parties contre le même joueur pour voir apparaître ton meilleur ennemi ou ta victime favorite.'));
    [['nemesis', '😈 Meilleur ennemi'], ['victim', '🎯 Victime favorite']].forEach(function (k) {
      var r = rv[k[0]];
      if (!r) return;
      var line = el('p', 'rival');
      line.append(el('strong', null, k[1] + ' : ' + r.name), el('span', 'muted', ' · ' + r.wins + ' victoire' + (r.wins > 1 ? 's' : '') + ' – ' + r.losses + ' défaite' + (r.losses > 1 ? 's' : '') + ' en face à face'));
      rivBox.append(line);
    });

    // carte à partager
    var cardBox = el('div', 'box c-lilac span-2');
    cardBox.append(el('h3', null, 'Ma carte à partager'));
    if (fiche && /^[0-9a-f]{16}$/.test(p.pid || '')) {
      var link = 'https://games.glsc.fr/j/' + p.pid + '/';
      var img = el('img', 'share-card'); img.src = '/cartes/' + p.pid + '.png'; img.alt = 'Ma carte de profil'; img.width = 1200; img.height = 630; img.loading = 'lazy';
      img.style.cssText = 'width:100%;height:auto;border:3px solid #111;box-shadow:5px 5px 0 #111;background:#FFFDF0';
      img.addEventListener('error', function () { img.hidden = true; });
      var share = el('div', 'btn-row');
      share.append(button('Copier le lien 📋', 'primary', function (b) {
        return (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () {
          b.textContent = 'Lien copié ✓'; setTimeout(function () { b.textContent = 'Copier le lien 📋'; }, 1500);
        }, function () { window.prompt('Copie ce lien :', link); });
      }));
      var dl = el('a', 'pbtn', 'Télécharger l’image'); dl.href = '/cartes/' + p.pid + '.png'; dl.download = 'ma-carte-glsc.png'; dl.style.cssText = 'text-decoration:none;display:inline-block';
      share.append(dl);
      cardBox.append(el('p', null, 'Colle le lien dans Discord ou WhatsApp : la carte s’affiche toute seule. Elle se met à jour après chaque partie.'), img, share);
    } else cardBox.append(el('p', null, 'Ta carte apparaît ici après ta première partie (comptez quelques minutes).'));

    // équipes
    var crewsBox = viewCrews();

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
    grid.append(stats, dailyBox, ach, histBox, rivBox, cardBox, crewsBox, manage, danger);
    show([head, grid]);
  }

  // ---------------------------------------------------------------- équipes entre amis
  function viewCrews() {
    var box = el('div', 'box c-banana span-2');
    box.append(el('h3', null, 'Mes équipes'),
      el('p', 'muted', 'Une équipe, c’est un classement privé entre amis : seuls ses membres le voient. Partage le code pour inviter.'));

    state.crews.forEach(function (c) {
      var card = el('div', 'crew');
      var head = el('div', 'crew-head');
      head.append(el('strong', 'crew-name', c.name), el('span', 'pill', c.members + ' membre' + (c.members > 1 ? 's' : '')),
        el('span', 'pill', c.owner ? '👑 créateur' : 'membre'));
      var code = button(c.code + ' 📋', null, function (b) {
        return (navigator.clipboard ? navigator.clipboard.writeText(c.code) : Promise.reject()).then(function () {
          b.textContent = 'Copié ✓'; setTimeout(function () { b.textContent = c.code + ' 📋'; }, 1500);
        }, function () { });
      });
      code.title = 'Code d’invitation : copier';
      var actions = el('div', 'btn-row');
      var panel = el('div', 'crew-panel');
      panel.hidden = state.openCrew !== c.id;
      var open = button(panel.hidden ? 'Classement' : 'Masquer', 'primary', function () {
        if (!panel.hidden) { panel.hidden = true; state.openCrew = null; open.textContent = 'Classement'; return; }
        return api('/crews/' + c.id).then(function (r) { fillCrew(panel, r.crew, card); panel.hidden = false; state.openCrew = c.id; open.textContent = 'Masquer'; },
          function (e) { fail(card, e); });
      });
      actions.append(open, code, button('Quitter', null, function () {
        if (!confirm('Quitter l’équipe « ' + c.name + ' » ?')) return;
        return api('/crews/leave', { id: c.id }).then(function () { state.openCrew = null; return load(); }, function (e) { fail(card, e); });
      }));
      if (c.owner) {
        actions.append(button('Nouveau code', null, function () {
          if (!confirm('L’ancien code ne fonctionnera plus. Continuer ?')) return;
          return api('/crews/new-code', { id: c.id }).then(function () { return load(); }, function (e) { fail(card, e); });
        }), button('Supprimer', 'danger', function () {
          var typed = prompt('Pour supprimer l’équipe, tape son nom : ' + c.name);
          if (typed === null) return;
          return api('/crews/delete', { id: c.id, confirm: typed }).then(function () { state.openCrew = null; return load(); }, function (e) { fail(card, e); });
        }));
      }
      card.append(head, actions, panel);
      box.append(card);
      if (state.openCrew === c.id) {
        api('/crews/' + c.id).then(function (r) { fillCrew(panel, r.crew, card); open.textContent = 'Masquer'; }, function () { });
      }
    });
    if (!state.crews.length) box.append(el('p', null, 'Tu n’es dans aucune équipe pour l’instant.'));

    var forms = el('div', 'profil-grid');
    var create = el('div', 'crew-form');
    var cname = field('Créer une équipe', { type: 'text', maxlength: '24', minlength: '2', placeholder: 'Les copains', autocomplete: 'off' });
    create.append(cname.wrap, button('Créer', null, function () {
      return api('/crews/create', { name: cname.input.value }).then(function (r) { state.openCrew = r.crew.id; return load(); }, function (e) { fail(create, e); });
    }));
    var join = el('div', 'crew-form');
    var ccode = field('Rejoindre avec un code', { type: 'text', placeholder: 'EQ-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
    join.append(ccode.wrap, button('Rejoindre', null, function () {
      return api('/crews/join', { code: ccode.input.value }).then(function (r) { state.openCrew = r.crew.id; return load(); }, function (e) { fail(join, e); });
    }));
    forms.append(create, join);
    box.append(forms);
    return box;
  }

  function fillCrew(panel, crew, card) {
    panel.textContent = '';
    var rows = crew.ranking.slice().sort(function (a, b) { return b.month.wins - a.month.wins || b.all.wins - a.all.wins; });
    var t = el('table', 'stat-table');
    var tr = el('tr'); ['#', 'Joueur', 'Ce mois-ci', 'Total'].forEach(function (h, i) { tr.append(el('th', i > 1 ? 'num' : null, h)); });
    var thead = el('thead'); thead.append(tr); t.append(thead);
    var tb = el('tbody');
    rows.forEach(function (r, i) {
      var row = el('tr');
      var who = el('td', null, (r.owner ? '👑 ' : '') + r.name + (r.me ? ' (toi)' : '') + (r.titles ? ' 🏅' : ''));
      if (crew.owner && !r.me) {
        var kick = el('button', 'kick', '✕'); kick.type = 'button'; kick.title = 'Retirer de l’équipe';
        kick.addEventListener('click', function () {
          if (!confirm('Retirer ' + r.name + ' de l’équipe ?')) return;
          api('/crews/kick', { id: crew.id, pid: r.pid }).then(function (x) { fillCrew(panel, x.crew, card); }, function (e) { fail(card, e); });
        });
        who.append(' ', kick);
      }
      row.append(el('td', null, ['🥇', '🥈', '🥉'][i] || String(i + 1)), who,
        el('td', 'num', n(r.month.wins) + ' vic. / ' + n(r.month.played)), el('td', 'num', n(r.all.wins) + ' vic. / ' + n(r.all.played)));
      tb.append(row);
    });
    t.append(tb); panel.append(t, el('p', 'muted', 'Victoires / parties, tous jeux confondus. Mis à jour chaque minute.'));
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
      state.daily = (res[2] && res[2].daily) || null;
      if (!state.profile) return viewGuest();
      return api('/crews').then(function (r) { state.crews = r.crews || []; }, function () { state.crews = []; }).then(viewProfile);
    }, function (e) { show([msg('Impossible de joindre le service de profils : ' + e.message, true)]); });
  }

  document.getElementById('year').textContent = new Date().getFullYear();
  load();
})();
