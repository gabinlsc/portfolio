// Script de la page — glsc.fr (games/index.html)
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();
})();

// Classements : /leaderboard.json est écrit chaque minute par la sonde de admin.glsc.fr à partir des parties terminées.
(function () {
  'use strict';
  var GAMES = {
    uno: { label: '+4', url: 'https://plus4.glsc.fr' }, // « uno » : identifiant interne de +4
    president: { label: 'Le Président', url: 'https://president.glsc.fr' },
    petitbac: { label: 'Petit Bac', url: 'https://petitbac.glsc.fr' },
    vortex: { label: 'Vortex', url: 'https://vortex.glsc.fr' }
  };
  var PERIODS = { week: '7 derniers jours', month: 'Ce mois-ci', all: 'Depuis toujours' };
  var MEDALS = ['🥇', '🥈', '🥉'];
  var state = { game: 'uno', period: 'week' };
  var data = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function n(x) { return Number(x || 0).toLocaleString('fr-FR'); }
  function plural(x, word) { return n(x) + '\u00a0' + word + (x > 1 ? 's' : ''); }

  function achievement(id) {
    return ((data && data.achievements) || []).filter(function (a) { return a.id === id; })[0];
  }

  // Succès du jeu affiché (et ceux qui valent pour tous les jeux) : qui les a débloqués, et le dernier à l'avoir fait.
  function drawAchievements() {
    var host = document.getElementById('board-ach');
    if (!host) return;
    host.textContent = '';
    var list = ((data && data.achievements) || []).filter(function (a) { return a.game === state.game || a.game === 'all'; });
    if (!list.length) return;
    host.append(el('h3', 'ach-title', 'Succès'));
    var grid = el('div', 'ach-grid');
    list.forEach(function (a) {
      var card = el('div', 'ach' + (a.count ? ' got' : ''));
      card.append(el('span', 'ach-emoji', a.emoji));
      var txt = el('div', 'ach-text');
      txt.append(el('strong', null, a.name), el('span', 'ach-desc', a.desc));
      txt.append(el('span', 'ach-who', a.count && a.recent && a.recent[0]
        ? plural(a.count, 'joueur') + ' · dernier : ' + a.recent[0].name
        : 'Personne pour l’instant'));
      card.append(txt);
      grid.append(card);
    });
    host.append(grid);
  }

  function tabs(host, options, key) {
    host.textContent = '';
    Object.keys(options).forEach(function (k) {
      var b = el('button', 'tab', typeof options[k] === 'string' ? options[k] : options[k].label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state[key] === k));
      b.addEventListener('click', function () { state[key] = k; draw(); });
      host.append(b);
    });
  }

  function table(game, top) {
    var t = el('table', 'board-table');
    var cols = game === 'vortex'
      ? [['Élim.', 'kills', ''], ['Morts', 'deaths', 'opt'], ['Ratio', 'kd', ''], ['Manches', 'played', 'opt']]
      : game === 'president'
        ? [['Président', 'wins', ''], ['Trou du cul', 'trouduc', 'opt'], ['Manches', 'played', ''], ['% Président', 'rate', 'opt']]
        : [['Victoires', 'wins', ''], ['Parties', 'played', ''], ['% victoires', 'rate', 'opt']];
    var head = el('tr');
    head.append(el('th', 'pos', '#'), el('th', null, 'Joueur'));
    cols.forEach(function (c) { head.append(el('th', 'num ' + c[2], c[0])); });
    var thead = el('thead'); thead.append(head);
    var body = el('tbody');
    top.forEach(function (p, i) {
      var tr = el('tr', i < 3 ? 'podium' : null);
      var who = el('td', 'who', p.name);
      if (p.profil) { var v = el('span', 'verif', ' ✓'); v.title = 'Profil : pseudo réservé'; who.append(v); }
      var shown = (p.badges || []).map(achievement).filter(Boolean);
      if (shown.length) {
        var bs = el('span', 'badges', shown.map(function (a) { return a.emoji; }).join(''));
        bs.title = shown.map(function (a) { return a.name; }).join(' · ');
        bs.setAttribute('aria-label', 'Succès : ' + bs.title);
        who.append(' ', bs);
      }
      tr.append(el('td', 'pos', MEDALS[i] || String(i + 1)), who);
      cols.forEach(function (c) {
        var v = c[1] === 'kd' ? (p.deaths ? (p.kills / p.deaths).toFixed(2).replace('.', ',') : n(p.kills))
          : c[1] === 'rate' ? Math.round((p.wins / Math.max(1, p.played)) * 100) + ' %'
          : n(p[c[1]]);
        tr.append(el('td', 'num ' + c[2], v));
      });
      body.append(tr);
    });
    t.append(thead, body);
    return t;
  }

  function draw() {
    tabs(document.getElementById('board-games'), GAMES, 'game');
    tabs(document.getElementById('board-period'), PERIODS, 'period');
    var g = (data.games[state.game] || {})[state.period] || { matches: 0, players: 0, top: [] };
    var stats = document.getElementById('board-stats');
    stats.textContent = '';
    stats.append(el('span', null, plural(g.matches, state.game === 'uno' || state.game === 'petitbac' ? 'partie' : 'manche') + ' jouée' + (g.matches > 1 ? 's' : '')),
      el('span', null, plural(g.players, 'joueur')));
    var host = document.getElementById('board-body');
    host.textContent = '';
    if (!g.top.length) {
      var p = el('p', 'board-empty', 'Personne au classement ' + (state.period === 'week' ? 'cette semaine' : 'pour l’instant') + ' : la première place est libre. ');
      var a = el('a', null, 'Jouer à ' + GAMES[state.game].label);
      a.href = GAMES[state.game].url;
      p.append(a);
      host.append(p);
    } else {
      host.append(table(state.game, g.top));
    }
    document.getElementById('board-note').textContent = (state.game === 'vortex'
      ? 'Éliminations cumulées sur les manches de 10 minutes, en FFA comme en équipes.'
      : state.game === 'president'
        ? 'Chaque manche compte : finir premier rapporte une place de président.'
        : state.game === 'petitbac'
          ? 'Parties gagnées au total des points sur toutes les manches.'
          : 'Parties gagnées, contre les bots comme entre joueurs.') + ' Avec le pseudo choisi en jouant, mis à jour chaque minute.';
    drawAchievements();
    if (state.game === 'president' && g.trouduc) {
      host.append(el('p', 'board-shame', '🧻 Abonné au trou du cul : ' + g.trouduc.name + ', ' + n(g.trouduc.trouduc) + ' fois' + ' sur ' + plural(g.trouduc.played, 'manche') + '.'));
    }
  }

  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function monthName(label) {
    var parts = label.split('-');
    return MONTHS[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  // Défi du jour : le même pour tout le monde ; connecté, on voit sa série et sa progression.
  function daily() {
    var host = document.getElementById('daily');
    if (!host || !data.daily) return;
    host.textContent = '';
    host.append(el('strong', null, '🎯 Défi du jour : '), el('span', null, data.daily.text + '.'));
    host.hidden = false;
    fetch('/api/profile/me', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
      if (!me || !me.profile) {
        host.append(' ', el('a', null, 'Crée ton profil pour suivre ta série.'));
        host.lastChild.href = '/profil/';
        return null;
      }
      return fetch('/players.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (pj) {
        var me2 = pj && pj.players && pj.players[me.profile.pid];
        if (!me2 || !me2.daily) return;
        var dl = me2.daily;
        host.append(' ', el('span', 'daily-chip', dl.done ? '✅ Relevé !' : Math.min(dl.progress, data.daily.goal) + ' / ' + data.daily.goal),
          ' ', el('span', 'daily-chip', '🔥 ' + dl.streak + ' jour' + (dl.streak > 1 ? 's' : '') + ' d’affilée'));
      });
    }).catch(function () { });
  }

  // Hall des champions : le meilleur joueur de chaque jeu, pour chaque mois écoulé.
  function hall() {
    var host = document.getElementById('hall');
    var list = data.seasons || [];
    if (!host || !list.length) return;
    var body = document.getElementById('hall-body');
    body.textContent = '';
    var months = [];
    list.forEach(function (c) { if (months.indexOf(c.month) < 0) months.push(c.month); });
    months.forEach(function (m) {
      var row = el('div', 'hall-month');
      row.append(el('h3', null, monthName(m)));
      list.filter(function (c) { return c.month === m; }).forEach(function (c) {
        var what = c.game === 'vortex' ? plural(c.kills, 'élimination') : plural(c.wins, 'victoire');
        var chip = el('span', 'hall-chip');
        chip.append(el('b', null, GAMES[c.game] ? GAMES[c.game].label : c.game), ' 🏅 ' + c.name + (c.profil ? ' ✓' : '') + ' · ' + what);
        row.append(chip);
      });
      body.append(row);
    });
    host.hidden = false;
  }

  // Sur chaque carte de jeu : le meilleur joueur des 7 derniers jours.
  function champions() {
    document.querySelectorAll('.game').forEach(function (card) {
      var play = card.querySelector('.act-play');
      var key = play && Object.keys(GAMES).filter(function (k) { return GAMES[k].url === play.getAttribute('href'); })[0];
      var top = key && data.games[key] && data.games[key].week.top[0];
      if (!top) return;
      var p = el('p', 'champ');
      var what = key === 'vortex' ? plural(top.kills, 'élimination') : key === 'president' ? n(top.wins) + ' fois président' : plural(top.wins, 'victoire');
      var who = el('strong', null, top.name);
      p.append('👑 Champion de la semaine : ', who, ' (' + what + ')');
      card.querySelector('.actions').before(p);
    });
  }

  fetch('/leaderboard.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.games) return;
    data = d;
    var u = d.games.uno;
    if (u && !u.week.top.length) state.period = u.month && u.month.top.length ? 'month' : (u.all.top.length ? 'all' : 'week');
    draw();
    champions();
    daily();
    hall();
    document.getElementById('classements').hidden = false;
  }).catch(function (e) { /* pas encore de classement : la section reste cachée */ if (window.console) console.warn('classements :', e); });
})();
