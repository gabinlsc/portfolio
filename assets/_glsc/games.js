// Script de la page — glsc.fr (games/index.html)
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();
})();

// Classements : /leaderboard.json est écrit chaque minute par la sonde de admin.glsc.fr à partir des parties terminées.
(function () {
  'use strict';
  var GAMES = {
    uno: { label: 'UNO', url: 'https://uno.glsc.fr' },
    president: { label: 'Le Président', url: 'https://president.glsc.fr' },
    vortex: { label: 'Vortex', url: 'https://vortex.glsc.fr' }
  };
  var PERIODS = { week: '7 derniers jours', all: 'Depuis toujours' };
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
      tr.append(el('td', 'pos', MEDALS[i] || String(i + 1)), el('td', 'who', p.name));
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
    stats.append(el('span', null, plural(g.matches, state.game === 'uno' ? 'partie' : 'manche') + ' jouée' + (g.matches > 1 ? 's' : '')),
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
        : 'Parties gagnées, contre les bots comme entre joueurs.') + ' Avec le pseudo choisi en jouant, mis à jour chaque minute.';
    if (state.game === 'president' && g.trouduc) {
      host.append(el('p', 'board-shame', '🧻 Abonné au trou du cul : ' + g.trouduc.name + ', ' + n(g.trouduc.trouduc) + ' fois' + ' sur ' + plural(g.trouduc.played, 'manche') + '.'));
    }
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
    if (!(d.games.uno && d.games.uno.week.top.length) && d.games.uno && d.games.uno.all.top.length) state.period = 'all';
    draw();
    champions();
    document.getElementById('classements').hidden = false;
  }).catch(function () { /* pas encore de classement : la section reste cachée */ });
})();
