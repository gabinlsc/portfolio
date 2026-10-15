<?php
/** Coffre à secrets (chiffré dans le navigateur), suivi alternance, réglages et journal de l'admin. */
declare(strict_types=1);

const APP_STATUSES = ['todo', 'sent', 'interview', 'refused', 'accepted'];
const ALERTS = [
    'login' => 'Connexion à l’admin',
    'login_fail' => 'Admin verrouillée après trop d’essais',
    'site_down' => 'Site ou service indisponible (status.glsc.fr)',
    'game_down' => 'Conteneur de jeu arrêté',
    'disk' => 'Disque plein à plus de 85 %',
    'memory' => 'Mémoire presque saturée',
    'cert' => 'Certificat HTTPS qui expire dans moins de 14 jours',
    'ssh' => 'Connexion SSH réussie au serveur',
    'deploy' => 'Fin d’un déploiement automatique (réussi ou raté)',
];

function vault_state(): array
{
    return [
        'meta' => setting('vault_meta') ? json_decode((string) setting('vault_meta'), true) : null,
        'items' => db()->query('SELECT id, label, iv, ct, updated FROM vault_items ORDER BY label COLLATE NOCASE')->fetchAll(),
    ];
}

/** base64 standard, bornée. */
function b64_in(array $src, string $key, int $max): string
{
    $v = str_in($src, $key, $max, true);
    if (!preg_match('#^[A-Za-z0-9+/]+={0,2}$#', $v)) fail(422, "Champ « $key » invalide.");
    return $v;
}

function school_state(): array
{
    return [
        'deadlines' => db()->query('SELECT * FROM deadlines ORDER BY done, due')->fetchAll(),
        'applications' => db()->query("SELECT * FROM applications ORDER BY CASE status WHEN 'interview' THEN 0 WHEN 'sent' THEN 1 WHEN 'todo' THEN 2 WHEN 'accepted' THEN 3 ELSE 4 END, updated DESC")->fetchAll(),
    ];
}

function settings_state(): array
{
    $hook = (string) setting('discord_webhook', '');
    $alerts = [];
    foreach (ALERTS as $key => $label) $alerts[] = ['key' => $key, 'label' => $label, 'on' => setting("alert_$key", '1') === '1'];
    return [
        'discord' => $hook !== '' ? substr($hook, 0, 40) . '…' : '',
        'alerts' => $alerts,
        'recovery_left' => recovery_left(),
        'log' => db()->query('SELECT at, ip, ua, event FROM admin_log ORDER BY at DESC LIMIT 40')->fetchAll(),
    ];
}

return [
    // ---------------------------------------------------------------- coffre
    // Le serveur ne voit jamais la phrase secrète ni les secrets en clair : seulement sel, IV et texte chiffré (AES-GCM).
    'GET vault/state' => fn () => vault_state(),
    'POST vault/init' => function () {
        if (setting('vault_meta')) fail(409, 'Le coffre existe déjà.');
        $b = body();
        $meta = ['salt' => b64_in($b, 'salt', 64), 'iterations' => int_in($b, 'iterations', 600000, 100000, 5000000),
                 'check_iv' => b64_in($b, 'check_iv', 64), 'check_ct' => b64_in($b, 'check_ct', 256)];
        set_setting('vault_meta', json_encode($meta));
        return vault_state();
    },
    'POST vault/save' => function () {
        if (!setting('vault_meta')) fail(409, 'Crée d’abord le coffre.');
        $b = body();
        $f = [str_in($b, 'label', 80, true), b64_in($b, 'iv', 64), b64_in($b, 'ct', 20000)];
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE vault_items SET label = ?, iv = ?, ct = ?, updated = ? WHERE id = ?')->execute([...$f, time(), $id]);
        } else {
            db()->prepare('INSERT INTO vault_items(label, iv, ct, created, updated) VALUES(?, ?, ?, ?, ?)')->execute([...$f, time(), time()]);
        }
        return vault_state();
    },
    'POST vault/delete' => function () {
        db()->prepare('DELETE FROM vault_items WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return vault_state();
    },
    'POST vault/reset' => function () {
        if (str_in(body(), 'confirm', 20) !== 'EFFACER') fail(422, 'Tape EFFACER pour confirmer.');
        db()->exec('DELETE FROM vault_items');
        set_setting('vault_meta', null);
        admin_log('coffre effacé');
        return vault_state();
    },

    // ---------------------------------------------------------------- alternance
    'GET school/list' => fn () => school_state(),
    'POST school/deadline-save' => function () {
        $b = body();
        $f = [str_in($b, 'title', 120, true), str_in($b, 'course', 60), date_in($b, 'due', true), str_in($b, 'notes', 2000)];
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE deadlines SET title = ?, course = ?, due = ?, notes = ? WHERE id = ?')->execute([...$f, $id]);
        } else {
            db()->prepare('INSERT INTO deadlines(title, course, due, notes, created) VALUES(?, ?, ?, ?, ?)')->execute([...$f, time()]);
        }
        return school_state();
    },
    'POST school/deadline-toggle' => function () {
        db()->prepare('UPDATE deadlines SET done = 1 - done WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return school_state();
    },
    'POST school/deadline-delete' => function () {
        db()->prepare('DELETE FROM deadlines WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return school_state();
    },
    'POST school/app-save' => function () {
        $b = body();
        $f = [str_in($b, 'company', 80, true), str_in($b, 'role', 80), enum_in($b, 'status', APP_STATUSES, 'todo'),
              date_in($b, 'applied_on'), $b['link'] ?? '' ? url_in($b, 'link') : '', str_in($b, 'notes', 2000)];
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE applications SET company = ?, role = ?, status = ?, applied_on = ?, link = ?, notes = ?, updated = ? WHERE id = ?')
                ->execute([...$f, time(), $id]);
        } else {
            db()->prepare('INSERT INTO applications(company, role, status, applied_on, link, notes, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([...$f, time(), time()]);
        }
        return school_state();
    },
    'POST school/app-delete' => function () {
        db()->prepare('DELETE FROM applications WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return school_state();
    },

    // ---------------------------------------------------------------- réglages
    'GET settings/get' => fn () => settings_state(),
    'POST settings/save' => function () {
        $b = body();
        if (array_key_exists('discord', $b)) {
            $hook = str_in($b, 'discord', 300);
            if ($hook !== '' && !preg_match('#^https://(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)/api/webhooks/\d+/[\w-]+$#', $hook)) {
                fail(422, 'Adresse de webhook Discord invalide.');
            }
            set_setting('discord_webhook', $hook === '' ? null : $hook);
            admin_log($hook === '' ? 'webhook Discord retiré' : 'webhook Discord modifié');
        }
        foreach ((array) ($b['alerts'] ?? []) as $key => $on) {
            if (isset(ALERTS[$key])) set_setting("alert_$key", $on ? '1' : '0');
        }
        return settings_state();
    },
    'POST settings/test-discord' => function () {
        if (!setting('discord_webhook')) fail(422, 'Enregistre d’abord un webhook.');
        glsc_queue('discord', ['title' => '👋 Test depuis admin.glsc.fr', 'text' => 'Les alertes arrivent bien ici.']) || fail(500, 'File d’attente indisponible.');
        return ['ok' => true, 'message' => 'Message envoyé à la sonde : il arrive sur Discord dans quelques secondes.'];
    },
];
