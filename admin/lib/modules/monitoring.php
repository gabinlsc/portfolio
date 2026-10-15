<?php
/**
 * Supervision : lit les mesures publiées chaque minute par la sonde root (glsc-admin-collect).
 * Rien ici n'a besoin de droits élevés : les actions (redémarrer un jeu) passent par la file d'attente.
 */
declare(strict_types=1);

const GAMES = ['uno' => 'UNO', 'president' => 'Le Président', 'vortex' => 'Vortex'];
const SITE_HOSTS = ['glsc.fr', 'cv.glsc.fr', 'share.glsc.fr', 'old.glsc.fr', 'games.glsc.fr', 'status.glsc.fr', 'click.glsc.fr',
                    'uno.glsc.fr', 'president.glsc.fr', 'vortex.glsc.fr', 'admin.glsc.fr'];

function m_all(string $sql, array $args = []): array
{
    $m = metrics();
    if (!$m) return [];
    $q = $m->prepare($sql);
    $q->execute($args);
    return $q->fetchAll();
}

function m_one(string $sql, array $args = []): mixed
{
    $m = metrics();
    if (!$m) return null;
    $q = $m->prepare($sql);
    $q->execute($args);
    return $q->fetchColumn();
}

function days_param(int $default = 7): int
{
    return (int) int_in($_GET, 'days', $default, 1, 90);
}

/** Série jour par jour (dates locales) complétée par des zéros. */
function daily(array $rows, int $days, array $fields): array
{
    $by = [];
    foreach ($rows as $r) $by[$r['day']] = $r;
    $out = [];
    for ($i = $days - 1; $i >= 0; $i--) {
        $day = date('Y-m-d', strtotime("-$i days"));
        $row = ['day' => $day];
        foreach ($fields as $f) $row[$f] = (int) ($by[$day][$f] ?? 0);
        $out[] = $row;
    }
    return $out;
}

/** Source lisible d'un référent : LinkedIn, Google, GitHub… ou le domaine. */
function source_of(string $ref): string
{
    if ($ref === '' || $ref === '-') return 'Direct';
    $host = strtolower((string) parse_url($ref, PHP_URL_HOST));
    $host = preg_replace('/^(www|m|l|lm)\./', '', $host);
    return match (true) {
        $host === '' => 'Direct',
        str_contains($host, 'linkedin') || $host === 'lnkd.in' => 'LinkedIn',
        str_contains($host, 'google') => 'Google',
        str_contains($host, 'bing') => 'Bing',
        str_contains($host, 'duckduckgo') => 'DuckDuckGo',
        str_contains($host, 'github') => 'GitHub',
        str_contains($host, 'indeed') => 'Indeed',
        str_contains($host, 'welcometothejungle') => 'Welcome to the Jungle',
        str_contains($host, 'discord') => 'Discord',
        str_ends_with($host, 'glsc.fr') => 'glsc.fr (interne)',
        default => $host,
    };
}

function status_json(): ?array
{
    $file = getenv('GLSC_STATUS_JSON') ?: '/var/www/status.glsc.fr/status.json';
    if (!is_readable($file)) return null;
    $d = json_decode((string) file_get_contents($file), true);
    return is_array($d) ? $d : null;
}

/** Problèmes en cours, pour le bandeau du tableau de bord. */
function current_alerts(?array $health, ?array $docker, ?array $status): array
{
    $alerts = [];
    if ($health) {
        $disk = $health['disk'] ?? null;
        if ($disk && $disk['total'] > 0 && $disk['used'] / $disk['total'] > 0.85) $alerts[] = ['level' => 'warn', 'text' => sprintf('Disque rempli à %d %%', round(100 * $disk['used'] / $disk['total']))];
        foreach ($health['certs'] ?? [] as $c) {
            if ($c['days'] !== null && $c['days'] < 14) $alerts[] = ['level' => $c['days'] < 5 ? 'bad' : 'warn', 'text' => "Certificat {$c['domain']} : expire dans {$c['days']} j"];
        }
        foreach ($health['services'] ?? [] as $s) {
            if ($s['present'] && !$s['active']) $alerts[] = ['level' => 'bad', 'text' => "Service {$s['name']} arrêté"];
        }
        if (time() - (int) ($health['at'] ?? 0) > 300) $alerts[] = ['level' => 'warn', 'text' => 'La sonde ne s’est pas exécutée depuis plus de 5 min'];
    } else {
        $alerts[] = ['level' => 'warn', 'text' => 'Pas encore de mesures de la sonde (glsc-admin-collect)'];
    }
    foreach ($docker['containers'] ?? [] as $c) {
        if ($c['state'] !== 'running') $alerts[] = ['level' => 'bad', 'text' => ($c['label'] ?? $c['name']) . ' : conteneur ' . $c['state']];
    }
    foreach ($status['services'] ?? [] as $s) {
        if (($s['status'] ?? 'up') === 'down') $alerts[] = ['level' => 'bad', 'text' => ($s['name'] ?? '?') . ' est indisponible'];
    }
    return $alerts;
}

return [
    // ---------------------------------------------------------------- tableau de bord
    'GET dashboard/summary' => function () {
        $health = snapshot('health');
        $docker = snapshot('docker');
        $github = snapshot('github');
        $status = status_json();
        $today = strtotime('today');
        $traffic = metrics() ? [
            'today' => (int) m_one('SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ?', [$today]),
            'visitors' => (int) m_one("SELECT COUNT(DISTINCT ip || ua) FROM requests WHERE page = 1 AND ts >= ?", [$today]),
            'yesterday' => (int) m_one('SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?', [$today - 86400, $today]),
            'week' => daily(m_all("SELECT day, COUNT(*) views FROM requests WHERE page = 1 AND ts >= ? GROUP BY day", [$today - 6 * 86400]), 7, ['views']),
        ] : null;
        $board = db()->query('SELECT id, name FROM boards ORDER BY position, id LIMIT 1')->fetch();
        $columns = $board ? db()->query('SELECT k.name, k.color, COUNT(c.id) n FROM columns k LEFT JOIN cards c ON c.column_id = k.id
                                         WHERE k.board_id = ' . (int) $board['id'] . ' GROUP BY k.id ORDER BY k.position, k.id')->fetchAll() : [];
        return [
            'alerts' => current_alerts($health, $docker, $status),
            'health' => $health ? ['cpu' => $health['cpu'], 'mem' => $health['mem'], 'swap' => $health['swap'], 'disk' => $health['disk'],
                                   'uptime' => $health['uptime'], 'load' => $health['load'], 'at' => $health['at']] : null,
            'traffic' => $traffic,
            'ssh_fails' => metrics() ? (int) m_one("SELECT COUNT(*) FROM ssh WHERE kind != 'accepted' AND ts >= ?", [time() - 86400]) : null,
            'games' => array_map(fn ($c) => ['name' => $c['label'] ?? $c['name'], 'state' => $c['state'], 'players' => $c['conns'] ?? 0], $docker['containers'] ?? []),
            'sites' => array_map(fn ($s) => ['name' => $s['name'] ?? '?', 'status' => $s['status'] ?? '?'], $status['services'] ?? []),
            'kanban' => ['board' => $board, 'columns' => $columns],
            'deadlines' => db()->query("SELECT id, title, course, due FROM deadlines WHERE done = 0 ORDER BY due LIMIT 4")->fetchAll(),
            'links' => db()->query('SELECT label, url, color FROM quicklinks ORDER BY position, id')->fetchAll(),
            'commits' => array_slice($github['commits'] ?? [], 0, 4),
            'files' => (int) db()->query('SELECT COUNT(*) FROM files WHERE expires > ' . time())->fetchColumn(),
        ];
    },

    // ---------------------------------------------------------------- trafic
    'GET traffic/summary' => function () {
        if (!metrics()) return ['ready' => false];
        $days = days_param();
        $since = strtotime('today') - ($days - 1) * 86400;
        $host = (string) ($_GET['host'] ?? '');
        $hostSql = '';
        $args = [$since];
        if ($host !== '') {
            if (!in_array($host, SITE_HOSTS, true)) fail(422, 'Site inconnu.');
            $hostSql = ' AND host = ?';
            $args[] = $host;
        }
        $w = "ts >= ?$hostSql";
        return [
            'ready' => true,
            'days' => $days,
            'hosts' => SITE_HOSTS,
            'totals' => m_all("SELECT COUNT(*) requests, SUM(page) views, COUNT(DISTINCT CASE WHEN page = 1 THEN ip || ua END) visitors,
                                      SUM(status >= 500) errors, SUM(status = 404) notfound, SUM(bot) bots, SUM(bytes) bytes
                               FROM requests WHERE $w", $args)[0] ?? [],
            'series' => daily(m_all("SELECT day, SUM(page) views, COUNT(DISTINCT CASE WHEN page = 1 THEN ip || ua END) visitors, COUNT(*) requests
                                     FROM requests WHERE $w GROUP BY day", $args), $days, ['views', 'visitors', 'requests']),
            'by_host' => m_all("SELECT host, SUM(page) views, COUNT(DISTINCT CASE WHEN page = 1 THEN ip || ua END) visitors, COUNT(*) requests
                                FROM requests WHERE ts >= ? GROUP BY host ORDER BY views DESC, requests DESC", [$since]),
            'pages' => m_all("SELECT host, path, COUNT(*) n FROM requests WHERE page = 1 AND $w GROUP BY host, path ORDER BY n DESC LIMIT 12", $args),
            'referers' => (function () use ($w, $args) {
                $out = [];
                foreach (m_all("SELECT referer, COUNT(*) n FROM requests WHERE page = 1 AND $w GROUP BY referer", $args) as $r) {
                    $s = source_of($r['referer']);
                    $out[$s] = ($out[$s] ?? 0) + $r['n'];
                }
                arsort($out);
                return array_map(fn ($k, $v) => ['source' => $k, 'n' => $v], array_keys($out), array_values($out));
            })(),
            'status' => m_all("SELECT CAST(status / 100 AS INTEGER) * 100 class, COUNT(*) n FROM requests WHERE $w GROUP BY class ORDER BY class", $args),
            'devices' => m_all("SELECT device, COUNT(*) n FROM requests WHERE page = 1 AND $w GROUP BY device ORDER BY n DESC", $args),
            'notfound' => m_all("SELECT host, path, COUNT(*) n FROM requests WHERE status = 404 AND scan = 0 AND bot = 0 AND $w GROUP BY host, path ORDER BY n DESC LIMIT 10", $args),
            'recent' => m_all("SELECT ts, host, ip, status, method, path, device, bot FROM requests WHERE $w AND path NOT LIKE '/\_glsc/%' ESCAPE '\\' ORDER BY ts DESC LIMIT 30", $args),
        ];
    },

    // ---------------------------------------------------------------- statistiques CV / Projets
    'GET cvstats/summary' => function () {
        if (!metrics()) return ['ready' => false];
        $days = days_param(30);
        $since = strtotime('today') - ($days - 1) * 86400;
        $sites = ['cv.glsc.fr' => 'CV', 'share.glsc.fr' => 'Projets'];
        $out = ['ready' => true, 'days' => $days, 'sites' => []];
        foreach ($sites as $host => $label) {
            $args = [$since, $host];
            $refs = [];
            foreach (m_all('SELECT referer, COUNT(*) n FROM requests WHERE page = 1 AND ts >= ? AND host = ? GROUP BY referer', $args) as $r) {
                $s = source_of($r['referer']);
                $refs[$s] = ($refs[$s] ?? 0) + $r['n'];
            }
            arsort($refs);
            $events = [];
            foreach (m_all("SELECT query, COUNT(*) n FROM requests WHERE ts >= ? AND host = ? AND path = '/_glsc/b.gif' GROUP BY query", $args) as $r) {
                parse_str((string) $r['query'], $qs);
                $name = preg_replace('/[^a-z0-9_:.-]/i', '', (string) ($qs['e'] ?? '')) ?: '?';
                $events[$name] = ($events[$name] ?? 0) + $r['n'];
            }
            arsort($events);
            $out['sites'][] = [
                'host' => $host,
                'label' => $label,
                'views' => (int) m_one('SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND host = ?', $args),
                'visitors' => (int) m_one('SELECT COUNT(DISTINCT ip || ua) FROM requests WHERE page = 1 AND ts >= ? AND host = ?', $args),
                'series' => daily(m_all('SELECT day, COUNT(*) views FROM requests WHERE page = 1 AND ts >= ? AND host = ? GROUP BY day', $args), $days, ['views']),
                'sources' => array_map(fn ($k, $v) => ['source' => $k, 'n' => $v], array_keys($refs), array_values($refs)),
                'devices' => m_all('SELECT device, COUNT(*) n FROM requests WHERE page = 1 AND ts >= ? AND host = ? GROUP BY device ORDER BY n DESC', $args),
                'langs' => m_all("SELECT CASE WHEN lang = '' THEN '?' ELSE lang END lang, COUNT(*) n FROM requests WHERE page = 1 AND ts >= ? AND host = ? GROUP BY lang ORDER BY n DESC LIMIT 6", $args),
                'events' => array_map(fn ($k, $v) => ['event' => $k, 'n' => $v], array_keys($events), array_values($events)),
                'recent' => m_all('SELECT ts, referer, device, lang FROM requests WHERE page = 1 AND ts >= ? AND host = ? ORDER BY ts DESC LIMIT 15', $args),
            ];
        }
        foreach ($out['sites'] as &$s) foreach ($s['recent'] as &$r) $r['source'] = source_of((string) $r['referer']);
        return $out;
    },

    // ---------------------------------------------------------------- santé du serveur
    'GET health/now' => function () {
        $range = ($_GET['range'] ?? '24h') === '7d' ? 7 * 86400 : 86400;
        $bucket = $range > 86400 ? 3600 : 600;
        $history = m_all("SELECT (ts / ?) * ? t, AVG(cpu) cpu, AVG(100.0 * mem_used / mem_total) mem, AVG(100.0 * swap_used / NULLIF(swap_total, 0)) swap,
                                 AVG(load1) load1, MAX(100.0 * disk_used / disk_total) disk
                          FROM health WHERE ts >= ? GROUP BY t ORDER BY t", [$bucket, $bucket, time() - $range]);
        return ['now' => snapshot('health'), 'history' => $history, 'deploys' => snapshot('deploys')];
    },

    // ---------------------------------------------------------------- sécurité
    'GET security/summary' => function () {
        $day = time() - 86400;
        $week = time() - 7 * 86400;
        return [
            'ready' => metrics() !== null,
            'ssh' => [
                'fails_24h' => (int) m_one("SELECT COUNT(*) FROM ssh WHERE kind != 'accepted' AND ts >= ?", [$day]),
                'fails_7d' => (int) m_one("SELECT COUNT(*) FROM ssh WHERE kind != 'accepted' AND ts >= ?", [$week]),
                'top_ips' => m_all("SELECT ip, COUNT(*) n, MAX(ts) last FROM ssh WHERE kind != 'accepted' AND ts >= ? GROUP BY ip ORDER BY n DESC LIMIT 10", [$week]),
                'users' => m_all("SELECT user, COUNT(*) n FROM ssh WHERE kind != 'accepted' AND ts >= ? GROUP BY user ORDER BY n DESC LIMIT 8", [$week]),
                'accepted' => m_all("SELECT ts, ip, user FROM ssh WHERE kind = 'accepted' ORDER BY ts DESC LIMIT 10"),
            ],
            'scans' => [
                'count_7d' => (int) m_one('SELECT COUNT(*) FROM requests WHERE scan = 1 AND ts >= ?', [$week]),
                'paths' => m_all('SELECT path, COUNT(*) n FROM requests WHERE scan = 1 AND ts >= ? GROUP BY path ORDER BY n DESC LIMIT 10', [$week]),
                'ips' => m_all('SELECT ip, COUNT(*) n, MAX(ts) last FROM requests WHERE scan = 1 AND ts >= ? GROUP BY ip ORDER BY n DESC LIMIT 10', [$week]),
            ],
            'fail2ban' => snapshot('security')['fail2ban'] ?? null,
            'admin' => db()->query('SELECT at, ip, ua, event FROM admin_log ORDER BY at DESC LIMIT 15')->fetchAll(),
        ];
    },

    // ---------------------------------------------------------------- jeux
    'GET games/live' => function () {
        $docker = snapshot('docker');
        $history = [];
        foreach (m_all('SELECT (ts / 900) * 900 t, game, MAX(conns) conns FROM games WHERE ts >= ? GROUP BY t, game ORDER BY t', [time() - 86400]) as $r) {
            $history[$r['game']][] = ['t' => (int) $r['t'], 'conns' => (int) $r['conns']];
        }
        $pending = [];
        foreach (glob(glsc_path('queue') . '/*.json') ?: [] as $f) {
            $j = json_decode((string) @file_get_contents($f), true);
            if (($j['type'] ?? '') === 'restart') $pending[] = $j['data']['game'] ?? '';
        }
        return ['docker' => $docker, 'history' => $history, 'pending' => $pending];
    },
    'POST games/restart' => function () {
        $game = enum_in(body(), 'game', array_keys(GAMES), '');
        glsc_queue('restart', ['game' => $game]) || fail(500, 'File d’attente indisponible.');
        admin_log('redémarrage demandé : ' . GAMES[$game]);
        return ['ok' => true, 'message' => GAMES[$game] . ' va redémarrer dans quelques secondes.'];
    },

    // ---------------------------------------------------------------- GitHub & déploiements
    'GET github/feed' => fn () => ['github' => snapshot('github'), 'deploys' => snapshot('deploys')],
];
