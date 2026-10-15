<?php
/**
 * Point d'entrée unique de admin.glsc.fr (nginx envoie tout ce qui n'est pas un fichier statique ici).
 *   GET  /            application (ou page de connexion)
 *   POST /login       connexion          POST /logout   déconnexion
 *   *    /api/<module>/<action>          API JSON (connecté, CSRF sur tout sauf GET)
 *   GET  /f/<jeton>   téléchargement public d'un fichier partagé
 *   POST /hooks/github                 webhook GitHub (signé) → déploiement automatique
 */
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/pages.php';

/** @return array<string, callable> « METHODE module/action » → fonction */
function api_routes(): array
{
    static $routes = null;
    if ($routes !== null) return $routes;
    $routes = [];
    foreach (glob(__DIR__ . '/modules/*.php') as $file) {
        $routes += (require $file);
    }
    return $routes;
}

function handle_request(): void
{
    security_headers();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = '/' . trim((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/');

    try {
        if (preg_match('#^/f/([A-Za-z0-9_-]{20,64})$#', $path, $m)) {
            api_routes(); // charge les modules (dont file_public)
            file_public($m[1], $method);
            return;
        }
        if ($path === '/hooks/github' && $method === 'POST') {
            api_routes(); // charge les modules (dont hook_github)
            hook_github();
        }
        if ($path === '/login' && $method === 'POST') {
            session_boot();
            csrf_check();
            $b = body();
            $error = login(str_in($b, 'password', 200), str_in($b, 'code', 20));
            if ($error !== null) json_out(['error' => $error], 401);
            json_out(['ok' => true, 'csrf' => csrf_token()]);
        }
        if ($path === '/logout' && $method === 'POST') {
            if (logged_in()) csrf_check();
            logout();
            json_out(['ok' => true]);
        }
        if (str_starts_with($path, '/api/')) {
            if (!logged_in()) fail(401, 'Session expirée, reconnecte-toi.');
            if ($method !== 'GET') csrf_check();
            $key = $method . ' ' . substr($path, 5);
            $routes = api_routes();
            if (!isset($routes[$key])) fail(404, 'Action inconnue.');
            json_out($routes[$key]());
        }
        if ($path === '/' && in_array($method, ['GET', 'HEAD'], true)) {
            header('Cache-Control: no-store');
            if (logged_in()) page_app();
            else page_login();
            return;
        }
        fail(404, 'Page introuvable.');
    } catch (HttpError $e) {
        if (str_starts_with($path, '/api/') || $method !== 'GET') json_out(['error' => $e->getMessage()], $e->status);
        http_response_code($e->status);
        page_message($e->status === 404 ? 'Page introuvable' : 'Erreur', $e->getMessage());
    } catch (Throwable $e) {
        error_log('[glsc-admin] ' . $e);
        if (str_starts_with($path, '/api/') || $method !== 'GET') json_out(['error' => 'Erreur interne du serveur.'], 500);
        http_response_code(500);
        page_message('Erreur', 'Erreur interne du serveur.');
    }
}
