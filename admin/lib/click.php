<?php
/** click.glsc.fr/<nom> → redirection 302 vers la cible du lien court, avec comptage. */
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/pages.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer-when-downgrade');
header('X-Robots-Tag: noindex');
header('Cache-Control: no-store');

$slug = strtolower(trim((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/'));

if ($slug === '') {
    header('Location: https://glsc.fr', true, 302);
    exit;
}

$link = false;
if (preg_match('/^[a-z0-9][a-z0-9_-]{0,39}$/', $slug)) {
    $q = db()->prepare('SELECT id, target FROM shortlinks WHERE slug = ? AND active = 1');
    $q->execute([$slug]);
    $link = $q->fetch();
}

if (!$link) {
    http_response_code(404);
    header("Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'");
    page_message('Lien introuvable', 'Ce lien court n’existe pas ou a été désactivé.');
    exit;
}

$ua = user_agent();
$device = device_of($ua);
if ($device !== 'robot') {
    $ref = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    $refHost = $ref !== '' ? (string) parse_url($ref, PHP_URL_HOST) : '';
    try {
        $pdo = db();
        $pdo->prepare('UPDATE shortlinks SET clicks = clicks + 1, last_click = ? WHERE id = ?')->execute([time(), $link['id']]);
        $pdo->prepare('INSERT INTO shortlink_clicks(link_id, at, referer, device) VALUES(?, ?, ?, ?)')
            ->execute([$link['id'], time(), mb_substr($refHost, 0, 120), $device]);
    } catch (Throwable $e) {
        error_log('[glsc-click] ' . $e->getMessage()); // le comptage ne doit jamais bloquer la redirection
    }
}
header('Location: ' . $link['target'], true, 302);
