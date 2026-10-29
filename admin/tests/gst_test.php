<?php
/** Tests de l'instance gst.glsc.fr (espace StudioGLSC) :  php admin/tests/gst_test.php */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/glsc-gst-test-' . bin2hex(random_bytes(4));
mkdir("$root/admin/app", 0777, true);
mkdir("$root/gst/app", 0777, true);
putenv("GLSC_ADMIN_VAR=$root/admin");
putenv("GLSC_ADMIN_ETC=$root/admin-etc");
putenv("GLSC_GST_VAR=$root/gst");
putenv("GLSC_GST_ETC=$root/gst-etc");
putenv('GLSC_ADMIN_INSTANCE=gst');
require __DIR__ . '/../lib/router.php';
require __DIR__ . '/../lib/billing.php';

$ok = 0;
function check(bool $cond, string $what): void { global $ok; if (!$cond) { fwrite(STDERR, "✗ $what\n"); exit(1); } $ok++; echo "✓ $what\n"; }

// ---- emplacements : identifiants et base à part, le reste est partagé avec l'admin
check(glsc_instance() === 'gst', 'instance gst reconnue');
check(glsc_path('auth') === "$root/gst-etc/auth.json", 'identifiants dans /etc/glsc-gst (pas ceux de l’admin)');
check(glsc_path('app_db') === "$root/gst/app/app.db", 'base de gst séparée de celle de l’admin');
check(glsc_path('studio_token') === "$root/admin-etc/studio-token", 'jeton du service studio partagé avec l’admin');
check(glsc_path('pub') === "$root/admin/pub" && glsc_path('metrics') === "$root/admin/pub/metrics.db", 'mesures de la sonde lues dans le dossier de l’admin');
check(glsc_path('queue') === "$root/admin/queue", 'alertes envoyées par la sonde de l’admin');
check(auth_config() === null, 'pas de connexion possible tant que gst n’est pas configuré');
check(str_contains((string) login('x', '000000'), 'glsc-admin-setup --gst'), 'message d’erreur : lancer glsc-admin-setup --gst');

// ---- base : migrations oui, contenu de départ de l'admin non
$pdo = db();
check((int) $pdo->query('PRAGMA user_version')->fetchColumn() >= 4, 'migrations appliquées sur la base de gst');
check((int) $pdo->query('SELECT COUNT(*) FROM boards')->fetchColumn() === 0 && (int) $pdo->query('SELECT COUNT(*) FROM quicklinks')->fetchColumn() === 0, 'pas de kanban ni de liens d’exemple dans gst');
check(!file_exists("$root/admin/app/app.db"), 'la base de l’admin n’est pas touchée');

// ---- routes : seulement les modules de l'espace StudioGLSC
$routes = api_routes();
foreach (['GET billing/overview', 'GET accounting/overview', 'GET studio/overview', 'GET gst/home'] as $k) check(isset($routes[$k]), "route $k disponible");
foreach (['GET kanban/boards', 'GET dashboard/summary', 'GET health/overview', 'GET files/list', 'POST deploy/redeploy'] as $k) check(!isset($routes[$k]), "route $k absente de gst");
$names = array_map(fn ($k) => explode('/', explode(' ', $k)[1])[0], array_keys($routes));
check(array_diff(array_unique($names), ['billing', 'accounting', 'studio', 'gst']) === [], 'aucun autre module chargé');

// ---- accueil
bill_set_test_mode(false);
$home = $routes['GET gst/home']();
check($home['revenue'] === 0 && $home['drafts'] === 0 && $home['studio']['down'] !== null, 'accueil : à zéro, service studio absent signalé sans planter');
check(in_array('ton SIRET (14 chiffres valides)', $home['seller_missing'], true), 'accueil : coordonnées à compléter listées');

// ---- import depuis l'admin
$env = ['GLSC_ADMIN_VAR' => "$root/admin", 'GLSC_ADMIN_ETC' => "$root/admin-etc", 'GLSC_GST_VAR' => "$root/gst2", 'GLSC_GST_ETC' => "$root/gst2-etc", 'GLSC_ADMIN_LIB' => realpath(__DIR__ . '/../lib')];
$run = function (array $args) use ($env): array {
    $p = proc_open([PHP_BINARY, __DIR__ . '/../bin/glsc-gst-import', ...$args], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env + ['PATH' => (string) getenv('PATH')]);
    $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
    return [proc_close($p), $out];
};
// base « admin » avec un client et un réglage de facturation
$sh = proc_open([PHP_BINARY, '-r', 'putenv("GLSC_ADMIN_INSTANCE=admin"); require getenv("GLSC_ADMIN_LIB")."/bootstrap.php"; db()->exec("INSERT INTO bill_clients(name, created, updated) VALUES(\'Boulangerie Test\', 1, 1)"); set_setting("billing_name", "Gabin Lescoat");'],
    [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env + ['PATH' => (string) getenv('PATH')]);
stream_get_contents($pipes[1]); stream_get_contents($pipes[2]); proc_close($sh);

[$code, $out] = $run(['--dry-run']);
check($code === 0 && str_contains($out, 'bill_clients       1 ligne') && str_contains($out, 'simulation'), 'import --dry-run : compte sans rien copier');
[$code, $out] = $run([]);
check($code === 0 && str_contains($out, 'Copié'), 'import : copie réussie');
$dst = new PDO('sqlite:' . "$root/gst2/app/app.db");
check($dst->query('SELECT name FROM bill_clients')->fetchColumn() === 'Boulangerie Test', 'import : le client est dans gst');
check($dst->query("SELECT value FROM settings WHERE key = 'billing_name'")->fetchColumn() === 'Gabin Lescoat', 'import : réglages de facturation copiés');
check((int) $dst->query("SELECT COUNT(*) FROM settings WHERE key LIKE 'totp%'")->fetchColumn() === 0, 'import : aucun réglage de sécurité copié');
[$code, $out] = $run([]);
check($code === 1 && str_contains($out, 'refusé'), 'import : second lancement refusé, rien n’est écrasé');

echo "\n$ok vérifications réussies\n";
