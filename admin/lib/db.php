<?php
/** Base SQLite de l'admin (app.db, écrite par PHP) et lecture des mesures de la sonde (metrics.db). */
declare(strict_types=1);

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $path = glsc_path('app_db');
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    migrate($pdo);
    return $pdo;
}

/** Mesures publiées par la sonde : copie figée remplacée d'un bloc chaque minute, ouverte en lecture seule. */
function metrics(): ?PDO
{
    static $pdo = false;
    if ($pdo !== false) return $pdo;
    $path = glsc_path('metrics');
    if (!is_readable($path)) return $pdo = null;
    $pdo = new PDO('sqlite:file:' . $path . '?mode=ro&immutable=1', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

/** Instantané JSON publié par la sonde (santé, docker, sécurité, github…). */
function snapshot(string $name): ?array
{
    $file = glsc_path('pub') . '/' . basename($name) . '.json';
    if (!is_readable($file)) return null;
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data : null;
}

function migrate(PDO $pdo): void
{
    $steps = [
        1 => <<<SQL
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE login_attempts (id INTEGER PRIMARY KEY, ip TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL);
            CREATE INDEX login_attempts_at ON login_attempts(at);
            CREATE TABLE admin_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ip TEXT NOT NULL, ua TEXT NOT NULL, event TEXT NOT NULL);
            CREATE INDEX admin_log_at ON admin_log(at);
            CREATE TABLE recovery_used (hash TEXT PRIMARY KEY, at INTEGER NOT NULL);

            CREATE TABLE boards (id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
            CREATE TABLE columns (id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'paper', position INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE cards (id INTEGER PRIMARY KEY, column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', due TEXT,
                position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);

            CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT 'banana', pinned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
            CREATE TABLE quicklinks (id INTEGER PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'sky', position INTEGER NOT NULL DEFAULT 0);

            CREATE TABLE shortlinks (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1, clicks INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_click INTEGER);
            CREATE TABLE shortlink_clicks (id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL REFERENCES shortlinks(id) ON DELETE CASCADE,
                at INTEGER NOT NULL, referer TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '');
            CREATE INDEX shortlink_clicks_link ON shortlink_clicks(link_id, at);

            CREATE TABLE files (id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, size INTEGER NOT NULL,
                mime TEXT NOT NULL, stored TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
                max_downloads INTEGER, downloads INTEGER NOT NULL DEFAULT 0);

            CREATE TABLE vault_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, iv TEXT NOT NULL, ct TEXT NOT NULL,
                created INTEGER NOT NULL, updated INTEGER NOT NULL);

            CREATE TABLE deadlines (id INTEGER PRIMARY KEY, title TEXT NOT NULL, course TEXT NOT NULL DEFAULT '', due TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
            CREATE TABLE applications (id INTEGER PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo', applied_on TEXT, link TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                created INTEGER NOT NULL, updated INTEGER NOT NULL);
            SQL,
        2 => <<<SQL
            CREATE TABLE bill_clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', siren TEXT NOT NULL DEFAULT '',
                vat_id TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', postcode TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
                country TEXT NOT NULL DEFAULT 'France', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
                created INTEGER NOT NULL, updated INTEGER NOT NULL);
            CREATE TABLE bill_docs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('quote', 'invoice', 'credit')),
                number TEXT UNIQUE, year INTEGER, seq INTEGER, status TEXT NOT NULL DEFAULT 'draft',
                client_id INTEGER NOT NULL REFERENCES bill_clients(id) ON DELETE RESTRICT, parent_id INTEGER REFERENCES bill_docs(id) ON DELETE RESTRICT,
                subtype TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', issue_date TEXT, due_date TEXT, valid_until TEXT, service_date TEXT,
                deposit_percent INTEGER NOT NULL DEFAULT 50, terms_days INTEGER NOT NULL DEFAULT 30, delivery TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                lines TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL DEFAULT 0, snapshot TEXT, paid_at TEXT, paid_method TEXT NOT NULL DEFAULT '',
                created INTEGER NOT NULL, updated INTEGER NOT NULL);
            CREATE UNIQUE INDEX bill_docs_seq ON bill_docs(kind, year, seq) WHERE seq IS NOT NULL;
            CREATE INDEX bill_docs_client ON bill_docs(client_id);
            CREATE INDEX bill_docs_parent ON bill_docs(parent_id);
            SQL,
        // 3 : mode test (les documents et clients existants restent « réels » : test = 0)
        3 => <<<SQL
            ALTER TABLE bill_clients ADD COLUMN test INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE bill_docs ADD COLUMN test INTEGER NOT NULL DEFAULT 0;
            DROP INDEX bill_docs_seq;
            CREATE UNIQUE INDEX bill_docs_seq ON bill_docs(kind, year, seq, test) WHERE seq IS NOT NULL;
            SQL,
        // 4 : comptabilité (dépenses facultatives, suivi des déclarations de cotisations)
        4 => <<<SQL
            CREATE TABLE bill_expenses (id INTEGER PRIMARY KEY, date TEXT NOT NULL, supplier TEXT NOT NULL DEFAULT '', label TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'autre', amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL);
            CREATE INDEX bill_expenses_date ON bill_expenses(date);
            CREATE TABLE bill_declarations (period TEXT PRIMARY KEY, declared_at TEXT, revenue_declared INTEGER, paid_at TEXT, amount_paid INTEGER,
                note TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL);
            SQL,
    ];
    $current = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
    foreach ($steps as $version => $sql) {
        if ($version <= $current) continue;
        $pdo->beginTransaction();
        try {
            $pdo->exec($sql);
            if ($version === 1) seed($pdo);
            $pdo->exec('PRAGMA user_version = ' . $version);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }
}

/** Contenu de départ : un tableau kanban et quelques liens rapides. */
function seed(PDO $pdo): void
{
    $now = time();
    $pdo->prepare('INSERT INTO boards(name, position, created) VALUES(?, 0, ?)')->execute(['Projets', $now]);
    $board = (int) $pdo->lastInsertId();
    $col = $pdo->prepare('INSERT INTO columns(board_id, name, color, position) VALUES(?, ?, ?, ?)');
    foreach ([['À faire', 'banana'], ['En cours', 'sky'], ['Fait', 'mint']] as $i => [$name, $color]) {
        $col->execute([$board, $name, $color, $i]);
    }
    $link = $pdo->prepare('INSERT INTO quicklinks(label, url, color, position) VALUES(?, ?, ?, ?)');
    $links = [
        ['glsc.fr', 'https://glsc.fr', 'banana'],
        ['Statut', 'https://status.glsc.fr', 'mint'],
        ['Salle de jeux', 'https://games.glsc.fr', 'lilac'],
        ['GitHub', 'https://github.com/gabinlsc', 'sky'],
        ['IONOS', 'https://my.ionos.fr', 'coral'],
    ];
    foreach ($links as $i => [$label, $url, $color]) $link->execute([$label, $url, $color, $i]);
}
