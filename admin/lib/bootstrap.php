<?php
/**
 * admin.glsc.fr — démarrage commun (site admin, click.glsc.fr et scripts CLI).
 *
 * Emplacements (modifiables par variables d'environnement, utile pour les tests) :
 *   GLSC_ADMIN_ETC  /etc/glsc-admin        auth.json (mot de passe + 2FA), lisible par www-data
 *   GLSC_ADMIN_VAR  /var/lib/glsc-admin    app/ (base + fichiers partagés), pub/ (mesures de la sonde), queue/, deploy/
 */
declare(strict_types=1);

const GLSC_VERSION = '1.0.0';
date_default_timezone_set('Europe/Paris');

function glsc_path(string $what): string
{
    static $etc = null, $var = null;
    $etc ??= rtrim(getenv('GLSC_ADMIN_ETC') ?: '/etc/glsc-admin', '/');
    $var ??= rtrim(getenv('GLSC_ADMIN_VAR') ?: '/var/lib/glsc-admin', '/');
    return match ($what) {
        'auth'    => "$etc/auth.json",
        'app_db'  => "$var/app/app.db",
        'files'   => "$var/app/files",
        'metrics' => "$var/pub/metrics.db",
        'pub'     => "$var/pub",
        'queue'   => "$var/queue",
        'deploy'  => "$var/deploy",                    // demandes de déploiement, traitées par glsc-deploy.service (root)
        'deploy_secret' => "$etc/github-webhook.secret", // secret partagé avec les webhooks GitHub
        'studio_token' => "$etc/studio-token",         // jeton partagé avec le service de studio.glsc.fr (port 3303, local)
        default   => throw new InvalidArgumentException("chemin inconnu : $what"),
    };
}

require __DIR__ . '/db.php';
require __DIR__ . '/http.php';
require __DIR__ . '/totp.php';
require __DIR__ . '/auth.php';

/** Dépose une tâche pour la sonde root (actions sur les jeux, messages Discord). Types filtrés côté sonde. */
function glsc_queue(string $type, array $data = []): bool
{
    $dir = glsc_path('queue');
    if (!is_dir($dir)) return false;
    $name = sprintf('%s/%d-%s.json', $dir, time(), bin2hex(random_bytes(6)));
    $tmp = "$name.tmp";
    if (file_put_contents($tmp, json_encode(['type' => $type, 'data' => $data, 'at' => time()])) === false) return false;
    return rename($tmp, $name);
}

/** Valeur d'un réglage (table settings). */
function setting(string $key, ?string $default = null): ?string
{
    $v = db()->prepare('SELECT value FROM settings WHERE key = ?');
    $v->execute([$key]);
    $r = $v->fetchColumn();
    return $r === false ? $default : (string) $r;
}

function set_setting(string $key, ?string $value): void
{
    if ($value === null) {
        db()->prepare('DELETE FROM settings WHERE key = ?')->execute([$key]);
        return;
    }
    db()->prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        ->execute([$key, $value]);
}

/** Prévient sur Discord si l'option est active (envoyé par la sonde, jamais depuis PHP). */
function notify(string $event, string $title, string $text = ''): void
{
    if (setting('alert_' . $event, '1') !== '1') return;
    glsc_queue('discord', ['title' => $title, 'text' => $text]);
}
