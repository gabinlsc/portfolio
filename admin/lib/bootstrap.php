<?php
/**
 * admin.glsc.fr — démarrage commun (site admin, click.glsc.fr et scripts CLI).
 *
 * Emplacements (modifiables par variables d'environnement, utile pour les tests) :
 *   GLSC_ADMIN_ETC  /etc/glsc-admin        auth.json (mot de passe + 2FA), lisible par www-data
 *   GLSC_ADMIN_VAR  /var/lib/glsc-admin    app/ (base + fichiers partagés), pub/ (mesures de la sonde), queue/, deploy/
 *
 * Deux instances du même code :
 *   admin  admin.glsc.fr  espace privé (défaut)
 *   gst    gst.glsc.fr    espace StudioGLSC (devis, factures, compta, demandes et projets clients) : ses propres identifiants
 *                         (/etc/glsc-gst/auth.json) et sa propre base (/var/lib/glsc-gst/app/app.db). Choisie par GLSC_ADMIN_INSTANCE.
 *                         Le jeton du service studio et les mesures de la sonde restent ceux de l'admin (lecture seule).
 */
declare(strict_types=1);

const GLSC_VERSION = '1.0.0';
date_default_timezone_set('Europe/Paris');

/** Instance servie : « admin » (défaut) ou « gst » (espace StudioGLSC). */
function glsc_instance(): string
{
    return getenv('GLSC_ADMIN_INSTANCE') === 'gst' ? 'gst' : 'admin';
}

function glsc_path(string $what): string
{
    static $etc = null, $var = null, $shared_etc = null, $shared_var = null;
    $gst = glsc_instance() === 'gst';
    // dossiers de l'admin : toujours utilisés pour ce qui est commun aux deux instances
    $shared_etc ??= rtrim(getenv('GLSC_ADMIN_ETC') ?: '/etc/glsc-admin', '/');
    $shared_var ??= rtrim(getenv('GLSC_ADMIN_VAR') ?: '/var/lib/glsc-admin', '/');
    $etc ??= $gst ? rtrim(getenv('GLSC_GST_ETC') ?: '/etc/glsc-gst', '/') : $shared_etc;
    $var ??= $gst ? rtrim(getenv('GLSC_GST_VAR') ?: '/var/lib/glsc-gst', '/') : $shared_var;
    return match ($what) {
        'auth'    => "$etc/auth.json",
        'app_db'  => "$var/app/app.db",
        'files'   => "$var/app/files",
        'metrics' => "$shared_var/pub/metrics.db",
        'pub'     => "$shared_var/pub",
        'queue'   => "$shared_var/queue",   // la sonde de l'admin envoie aussi les alertes de gst
        'deploy'  => "$var/deploy",                    // demandes de déploiement, traitées par glsc-deploy.service (root)
        'deploy_secret' => "$etc/github-webhook.secret", // secret partagé avec les webhooks GitHub
        'studio_token' => "$shared_etc/studio-token",         // jeton partagé avec le service de studio.glsc.fr (port 3303, local)
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
