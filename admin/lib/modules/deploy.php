<?php
/**
 * Déploiement automatique : un push sur main (webhook GitHub signé) ou le bouton de l'admin
 * dépose une demande dans /var/lib/glsc-admin/deploy ; glsc-deploy.service (root) la traite
 * et publie l'historique dans pub/deploy-runs.json et les journaux dans pub/deploy-logs/.
 */
declare(strict_types=1);

/** Dépôt GitHub → cible de déploiement (la sonde accepte les mêmes cibles, rien d'autre). */
const DEPLOY_REPOS = [
    'gabinlsc/portfolio' => 'portfolio',
    'gabinlsc/uno' => 'uno',
    'gabinlsc/president' => 'president',
    'gabinlsc/vortex-fps' => 'vortex',
];
const DEPLOY_TARGETS = [
    'portfolio' => 'Sites, status et admin (deploy3 + deploy5 admin)',
    'portfolio-full' => 'Tout, jeux compris (deploy5 complet)',
    'uno' => 'UNO (image reconstruite)',
    'president' => 'Le Président (image reconstruite)',
    'vortex' => 'Vortex (image reconstruite)',
];
/** Fichiers du portfolio qui demandent de reconstruire les jeux (deploy5 complet). */
const DEPLOY_GAMES_FILES = '#^(deploy/games/|deploy/nginx/game-|deploy/nginx/glsc-games\.conf$|deploy/deploy4\.sh$)#';
const DEPLOY_HOOK_MAX = 5_000_000;

function deploy_request(string $target, array $info): bool
{
    $dir = glsc_path('deploy');
    if (!isset(DEPLOY_TARGETS[$target]) || !is_dir($dir)) return false;
    $name = sprintf('%s/%d-%s.json', $dir, time(), bin2hex(random_bytes(6)));
    $data = ['target' => $target, 'at' => time()] + array_intersect_key($info, array_flip(['sha', 'message', 'by', 'source']));
    if (file_put_contents("$name.tmp", json_encode($data, JSON_UNESCAPED_UNICODE)) === false) return false;
    return rename("$name.tmp", $name);
}

/** Garde les 15 derniers appels du webhook, pour vérifier la configuration depuis l'admin. */
function hook_note(string $event, string $repo, string $result): void
{
    $list = json_decode((string) setting('deploy_hooks', '[]'), true) ?: [];
    array_unshift($list, ['at' => time(), 'event' => substr($event, 0, 40), 'repo' => substr($repo, 0, 80), 'result' => $result]);
    set_setting('deploy_hooks', json_encode(array_slice($list, 0, 15), JSON_UNESCAPED_UNICODE));
}

function deploy_secret(): string
{
    $file = glsc_path('deploy_secret');
    return is_readable($file) ? trim((string) file_get_contents($file)) : '';
}

/** POST /hooks/github : appelé par GitHub, sans session. Seule la signature HMAC fait foi. */
function hook_github(): never
{
    header('Cache-Control: no-store');
    $secret = deploy_secret();
    if (strlen($secret) < 32) json_out(['error' => 'Déploiement automatique non configuré.'], 503);
    $raw = file_get_contents('php://input', false, null, 0, DEPLOY_HOOK_MAX + 1);
    if ($raw === false || strlen($raw) > DEPLOY_HOOK_MAX) json_out(['error' => 'Requête trop grosse.'], 413);
    $event = preg_replace('/[^a-z_]/', '', strtolower((string) ($_SERVER['HTTP_X_GITHUB_EVENT'] ?? '')));
    $sig = (string) ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
    if (!hash_equals('sha256=' . hash_hmac('sha256', $raw, $secret), $sig)) {
        hook_note($event, '', 'signature refusée');
        json_out(['error' => 'Signature invalide.'], 401);
    }
    $p = json_decode($raw, true);
    if (!is_array($p)) json_out(['error' => 'JSON invalide.'], 400);
    $repo = (string) ($p['repository']['full_name'] ?? '');
    $ignore = function (string $why) use ($event, $repo): never {
        hook_note($event, $repo, "ignoré : $why");
        json_out(['ok' => true, 'ignored' => $why], 202);
    };

    if ($event === 'ping') {
        hook_note($event, $repo, 'ping reçu, webhook prêt');
        json_out(['ok' => true, 'pong' => true]);
    }
    if ($event !== 'push') $ignore("événement $event");
    $target = DEPLOY_REPOS[$repo] ?? null;
    if ($target === null) $ignore('dépôt non suivi');
    if (($p['ref'] ?? '') !== 'refs/heads/main') $ignore('pas la branche main');
    if (!empty($p['deleted'])) $ignore('branche supprimée');

    if ($target === 'portfolio') {
        foreach (array_slice((array) ($p['commits'] ?? []), 0, 200) as $c) {
            foreach (['added', 'modified', 'removed'] as $k) {
                foreach ((array) ($c[$k] ?? []) as $file) {
                    if (is_string($file) && preg_match(DEPLOY_GAMES_FILES, $file)) $target = 'portfolio-full';
                }
            }
        }
    }
    $head = (array) ($p['head_commit'] ?? []);
    $sha = preg_match('/^[0-9a-f]{40}$/', (string) ($p['after'] ?? '')) ? (string) $p['after'] : '';
    // « Merge pull request #18 from … » : on garde plutôt le titre de la PR (3e ligne du message)
    $lines = array_values(array_filter(array_map('trim', explode("\n", (string) ($head['message'] ?? ''))), 'strlen'));
    $msg = $lines[0] ?? '';
    if (preg_match('/^Merge pull request (#\d+)/', $msg, $m) && isset($lines[1])) $msg = "{$m[1]} · {$lines[1]}";
    $msg = mb_substr($msg, 0, 200);
    $ok = deploy_request($target, ['sha' => $sha, 'message' => $msg, 'by' => mb_substr((string) ($p['pusher']['name'] ?? ''), 0, 60), 'source' => 'github']);
    hook_note($event, $repo, $ok ? "déploiement « $target » demandé" : 'échec : file de déploiement absente');
    json_out($ok ? ['ok' => true, 'target' => $target] : ['error' => 'File de déploiement absente.'], $ok ? 202 : 503);
}

return [
    'GET deploy/state' => function (): array {
        $secret = deploy_secret();
        $pending = glob(glsc_path('deploy') . '/*.json') ?: [];
        return [
            'configured' => strlen($secret) >= 32,
            'secret' => $secret,
            'url' => 'https://' . ($_SERVER['HTTP_HOST'] ?? 'admin.glsc.fr') . '/hooks/github',
            'repos' => array_keys(DEPLOY_REPOS),
            'targets' => DEPLOY_TARGETS,
            'hooks' => json_decode((string) setting('deploy_hooks', '[]'), true) ?: [],
            'pending' => count($pending),
            'runs' => snapshot('deploy-runs')['runs'] ?? [],
        ];
    },
    'POST deploy/run' => function (): array {
        $target = enum_in(body(), 'target', array_keys(DEPLOY_TARGETS), 'portfolio');
        if (!deploy_request($target, ['source' => 'admin', 'by' => 'admin'])) fail(503, 'File de déploiement absente (relance deploy5).');
        admin_log("déploiement « $target » demandé");
        return ['ok' => true, 'message' => 'Déploiement demandé : il démarre dans quelques secondes.'];
    },
    'GET deploy/log' => function (): array {
        $id = (string) ($_GET['id'] ?? '');
        if (!preg_match('/^[0-9]{8}-[0-9]{6}-[a-z-]{1,20}$/', $id)) fail(422, 'Journal inconnu.');
        $file = glsc_path('pub') . "/deploy-logs/$id.log";
        if (!is_readable($file)) fail(404, 'Journal introuvable.');
        $size = filesize($file);
        $text = (string) file_get_contents($file, false, null, max(0, $size - 200_000));
        return ['id' => $id, 'text' => $text, 'truncated' => $size > 200_000];
    },
];
