// Script de la page — status.glsc.fr
(function () {
  'use strict';

  var REFRESH_MS = 60000;
  var STATE_LABEL = { up: 'Opérationnel', degraded: 'Lent', down: 'Indisponible' };
  var GROUP_ICON = { 'Sites web': ['🌐', 'var(--sky)'], 'Jeux': ['🎮', 'var(--coral)'], 'Infrastructure': ['🗄️', 'var(--lilac)'] };
  var OVERALL = {
    up: ['✅', 'Tous les services sont opérationnels', 'Tout roule, rien à signaler.'],
    degraded: ['🐢', 'Certains services sont lents', 'Tout répond, mais plus lentement que d\'habitude.'],
    partial: ['🚧', 'Perturbation en cours', 'Au moins un service ne répond plus. Les autres fonctionnent.'],
    down: ['🔥', 'Panne générale', 'Aucun service ne répond pour le moment.'],
    error: ['📡', 'Données indisponibles', 'Impossible de charger l\'état des services. Nouvel essai dans une minute.']
  };

  var data = null;
  var $ = function (id) { return document.getElementById(id); };
  $('year').textContent = new Date().getFullYear();

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' s';
    if (sec < 3600) return Math.floor(sec / 60) + ' min';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h < 24) return h + ' h ' + (m < 10 ? '0' : '') + m;
    var d = Math.floor(h / 24);
    return d + ' j ' + (h % 24) + ' h';
  }
  function fmtPct(v) { return v == null ? '–' : (v >= 99.995 ? '100' : v.toFixed(2).replace('.', ',')) + ' %'; }
  function fmtDate(iso) {
    return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function gauge(id, pct) {
    var g = $(id);
    g.style.width = Math.min(100, Math.max(0, pct)) + '%';
    g.className = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  }

  function renderOverall(state) {
    var o = OVERALL[state] || OVERALL.error;
    $('overall').setAttribute('data-state', state);
    $('overall-emoji').textContent = o[0];
    $('overall-title').textContent = o[1];
    $('overall-text').textContent = o[2];
  }

  function renderServer(s) {
    if (!s) return;
    $('server').hidden = false;
    $('m-uptime').textContent = s.uptime_s != null ? fmtDuration(s.uptime_s) : '–';
    if (s.load) {
      var pct = s.cpus ? 100 * s.load[0] / s.cpus : 0;
      $('m-load').textContent = s.load[0].toFixed(2).replace('.', ',');
      gauge('g-load', pct);
    }
    if (s.mem_pct != null) { $('m-mem').textContent = Math.round(s.mem_pct) + ' %'; gauge('g-mem', s.mem_pct); }
    if (s.disk_pct != null) { $('m-disk').textContent = Math.round(s.disk_pct) + ' %'; gauge('g-disk', s.disk_pct); }
  }

  function renderServices(d) {
    var root = $('groups');
    root.textContent = '';
    var groups = {};
    var order = [];
    d.services.forEach(function (s) {
      if (!groups[s.group]) { groups[s.group] = []; order.push(s.group); }
      groups[s.group].push(s);
    });
    var tpl = $('tpl-svc');
    order.forEach(function (g) {
      var icon = GROUP_ICON[g] || ['⚙️', 'var(--peach)'];
      var h = el('h2', 'group-title');
      var gi = el('span', 'group-icon', icon[0]);
      gi.style.background = icon[1];
      gi.setAttribute('aria-hidden', 'true');
      h.appendChild(gi);
      h.appendChild(document.createTextNode(g));
      root.appendChild(h);

      var list = el('div', 'services');
      groups[g].forEach(function (s) {
        var node = tpl.content.firstElementChild.cloneNode(true);
        var h3 = node.querySelector('h3');
        if (s.link) {
          var a = el('a', null, s.name);
          a.href = s.link;
          h3.appendChild(a);
        } else {
          h3.textContent = s.name;
        }
        node.querySelector('.svc-name p').textContent = s.description || '';

        var pill = node.querySelector('.pill');
        pill.setAttribute('data-state', s.state);
        pill.appendChild(el('span', null, STATE_LABEL[s.state] || s.state));

        var stats = node.querySelector('.stats');
        if (s.latency_ms != null) stats.appendChild(el('span', s.state === 'degraded' ? 'warn' : '', s.latency_ms + ' ms'));
        if (s.state === 'down' && s.detail) stats.appendChild(el('span', 'bad', s.detail));
        stats.appendChild(el('span', s.uptime_24h < 99 ? 'warn' : '', '24 h : ' + fmtPct(s.uptime_24h)));
        stats.appendChild(el('span', s.uptime_30d < 99 ? 'warn' : '', '30 j : ' + fmtPct(s.uptime_30d)));
        if (s.cert_days != null) {
          stats.appendChild(el('span', s.cert_days < 7 ? 'bad' : s.cert_days < 15 ? 'warn' : '',
            '🔒 certificat : ' + s.cert_days + ' j'));
        }

        var bars = node.querySelector('.bars');
        s.days.forEach(function (v, i) {
          var b = el('i', v == null ? '' : v >= 99.9 ? 'b-ok' : v >= 95 ? 'b-warn' : 'b-bad');
          b.title = d.day_labels[i] + ' : ' + (v == null ? 'pas de données' : fmtPct(v));
          bars.appendChild(b);
        });
        list.appendChild(node);
      });
      root.appendChild(list);
    });
  }

  function renderIncidents(list) {
    var box = $('incidents');
    box.textContent = '';
    if (!list.length) {
      box.appendChild(el('p', 'empty', '🎉 Aucun incident enregistré. Pourvu que ça dure !'));
      return;
    }
    list.forEach(function (i) {
      var open = !i.end;
      var card = el('div', 'incident' + (open ? ' open' : ''));
      card.appendChild(el('span', 'emoji', open ? '🔴' : '✅'));
      var body = el('div');
      body.appendChild(el('strong', null, i.name + (open ? ' : en cours' : ' : résolu')));
      body.appendChild(el('p', null,
        'Début ' + fmtDate(i.start) + ' · ' + (open ? 'depuis ' : 'durée ') + fmtDuration(i.duration_s) +
        (i.detail ? ' · ' + i.detail : '')));
      card.appendChild(body);
      box.appendChild(card);
    });
  }

  function tickUpdated() {
    if (!data) return;
    var age = (Date.now() - new Date(data.generated_at).getTime()) / 1000;
    var stale = age > 3 * (data.interval_s || 60);
    $('live').classList.toggle('stale', stale);
    $('updated').textContent = stale ? 'Données figées depuis ' + fmtDuration(age) : 'Mis à jour il y a ' + fmtDuration(age);
  }

  function load() {
    fetch('/status.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        data = d;
        renderOverall(d.overall);
        renderServer(d.server);
        renderServices(d);
        renderIncidents(d.incidents || []);
        tickUpdated();
      })
      .catch(function () {
        if (!data) renderOverall('error');
        $('updated').textContent = 'Hors ligne';
        $('live').classList.add('stale');
      });
  }

  load();
  setInterval(load, REFRESH_MS);
  setInterval(tickUpdated, 5000);
})();
