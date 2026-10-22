<?php
/**
 * StudioGLSC : demandes de devis, projets clients (suivi privé) et statistiques de studio.glsc.fr.
 * Les données vivent dans le service « studio » (conteneur, deploy/studio/server.mjs) ; l'admin lui parle sur le port local 3303
 * avec un jeton lu dans /etc/glsc-admin/studio-token. Les statistiques viennent de la sonde (pub/studio-stats.json).
 */
declare(strict_types=1);

const STUDIO_REQUEST_STATUSES = ['new', 'contacted', 'quote', 'won', 'lost'];
const STUDIO_PROJECT_STATUSES = ['active', 'done', 'archived'];

function studio_base(): string
{
    return rtrim(getenv('GLSC_STUDIO_API') ?: 'http://127.0.0.1:3303', '/');
}

function studio_token(): string
{
    $file = glsc_path('studio_token');
    return is_readable($file) ? trim((string) file_get_contents($file)) : '';
}

/** Appelle le service (réponse JSON décodée). Lève une erreur HTTP claire si le service est absent ou refuse. */
function studio_call(string $method, string $path, ?array $body = null): array
{
    $token = studio_token();
    if ($token === '') fail(503, 'Le service studio n’est pas encore installé (jeton absent). Lance un déploiement des jeux.');
    $headers = "X-Admin-Token: $token\r\nAccept: application/json\r\n";
    $opts = ['method' => $method, 'timeout' => 6, 'ignore_errors' => true, 'header' => $headers];
    if ($body !== null) {
        $opts['header'] .= "Content-Type: application/json\r\n";
        $opts['content'] = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    $raw = @file_get_contents(studio_base() . $path, false, stream_context_create(['http' => $opts]));
    if ($raw === false) fail(502, 'Le service studio ne répond pas (docker logs glsc-games-studio-1).');
    $code = 0;
    foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) $code = (int) $m[1];
    $data = json_decode($raw, true);
    if ($code >= 400) fail($code === 401 ? 502 : $code, is_array($data) && isset($data['error']) ? (string) $data['error'] : 'Erreur du service studio.');
    return is_array($data) ? $data : [];
}

function studio_id(array $b, string $key = 'id'): string
{
    $v = str_in($b, $key, 40, true);
    if (!preg_match('/^[0-9a-f]{12,16}$/', $v)) fail(422, "Champ « $key » invalide.");
    return $v;
}

return [
    'GET studio/overview' => function () {
        $stats = snapshot('studio-stats');
        try {
            $svc = studio_call('GET', '/admin/overview');
        } catch (HttpError $e) {
            return ['down' => $e->getMessage(), 'stats' => $stats, 'requests' => [], 'projects' => []];
        }
        return $svc + ['stats' => $stats, 'down' => null];
    },
    'POST studio/request' => function () {
        $b = body();
        $out = ['id' => studio_id($b)];
        if (array_key_exists('status', $b)) {
            $st = str_in($b, 'status', 20, true);
            if (!in_array($st, STUDIO_REQUEST_STATUSES, true)) fail(422, 'Statut inconnu.');
            $out['status'] = $st;
        }
        if (array_key_exists('note', $b)) $out['note'] = str_in($b, 'note', 2000);
        return studio_call('POST', '/admin/request', $out);
    },
    'POST studio/request/delete' => fn () => studio_call('POST', '/admin/request/delete', ['id' => studio_id(body())]),
    'POST studio/project/create' => function () {
        $b = body();
        return studio_call('POST', '/admin/project/create', ['title' => str_in($b, 'title', 80, true), 'client' => str_in($b, 'client', 80, true)]);
    },
    'POST studio/project/update' => function () {
        $b = body();
        $out = ['id' => studio_id($b)];
        if (array_key_exists('current', $b)) $out['current'] = int_in($b, 'current', 0, 0, 10);
        if (array_key_exists('status', $b)) {
            $st = str_in($b, 'status', 20, true);
            if (!in_array($st, STUDIO_PROJECT_STATUSES, true)) fail(422, 'Statut inconnu.');
            $out['status'] = $st;
        }
        if (array_key_exists('title', $b)) $out['title'] = str_in($b, 'title', 80, true);
        if (array_key_exists('client', $b)) $out['client'] = str_in($b, 'client', 80, true);
        if (bool_in($b, 'read')) $out['read'] = true;
        return studio_call('POST', '/admin/project/update', $out);
    },
    'POST studio/project/message' => function () {
        $b = body();
        return studio_call('POST', '/admin/project/message', ['id' => studio_id($b), 'text' => str_in($b, 'text', 2000, true)]);
    },
    'POST studio/project/link' => fn () => studio_call('POST', '/admin/project/link', ['id' => studio_id(body())]),
    'POST studio/project/delete' => fn () => studio_call('POST', '/admin/project/delete', ['id' => studio_id(body())]),
    'POST studio/project/file/delete' => function () {
        $b = body();
        return studio_call('POST', '/admin/project/file/delete', ['id' => studio_id($b), 'file' => studio_id($b, 'file')]);
    },
    // Téléchargement d'un fichier déposé par un client (toujours en pièce jointe, jamais affiché dans la page).
    'GET studio/file' => function () {
        $pid = (string) ($_GET['project'] ?? '');
        $fid = (string) ($_GET['file'] ?? '');
        if (!preg_match('/^[0-9a-f]{12}$/', $pid) || !preg_match('/^[0-9a-f]{16}$/', $fid)) fail(422, 'Fichier invalide.');
        $token = studio_token();
        if ($token === '') fail(503, 'Le service studio n’est pas installé.');
        $ctx = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 15, 'ignore_errors' => true, 'header' => "X-Admin-Token: $token\r\n"]]);
        $raw = @file_get_contents(studio_base() . "/admin/file/$pid/$fid", false, $ctx);
        $code = 0;
        $disposition = '';
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) $code = (int) $m[1];
            if (stripos($h, 'Content-Disposition:') === 0) $disposition = trim(substr($h, 20));
        }
        if ($raw === false || $code !== 200) fail($code === 404 ? 404 : 502, 'Fichier introuvable.');
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: ' . ($disposition !== '' ? $disposition : 'attachment'));
        header('Content-Length: ' . strlen($raw));
        header('Cache-Control: no-store');
        echo $raw;
        exit;
    },
];
