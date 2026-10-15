<?php
/**
 * Partage de fichiers : envoi depuis l'admin, lien public https://admin.glsc.fr/f/<jeton>
 * qui expire (1 h → 30 j) et peut être limité en nombre de téléchargements.
 */
declare(strict_types=1);

const FILE_MAX_BYTES = 200 * 1024 * 1024;
const FILE_TTL = ['1h' => 3600, '1d' => 86400, '7d' => 7 * 86400, '30d' => 30 * 86400];

function files_cleanup(): void
{
    $q = db()->prepare('SELECT id, stored FROM files WHERE expires < ? OR (max_downloads IS NOT NULL AND downloads >= max_downloads)');
    $q->execute([time()]);
    foreach ($q->fetchAll() as $f) {
        @unlink(glsc_path('files') . '/' . basename($f['stored']));
        db()->prepare('DELETE FROM files WHERE id = ?')->execute([$f['id']]);
    }
}

function files_rows(): array
{
    files_cleanup();
    return db()->query('SELECT id, token, name, size, mime, created, expires, max_downloads, downloads FROM files ORDER BY created DESC')->fetchAll();
}

function human_size(int $bytes): string
{
    $units = ['o', 'Ko', 'Mo', 'Go'];
    $i = 0;
    $v = (float) $bytes;
    while ($v >= 1024 && $i < 3) { $v /= 1024; $i++; }
    return ($i ? number_format($v, 1, ',', ' ') : (string) $bytes) . ' ' . $units[$i];
}

/** Page publique /f/<jeton> : fiche du fichier, puis téléchargement avec ?dl=1. */
function file_public(string $token, string $method): void
{
    if (!in_array($method, ['GET', 'HEAD'], true)) fail(405, 'Méthode non autorisée.');
    files_cleanup();
    $q = db()->prepare('SELECT * FROM files WHERE token = ?');
    $q->execute([$token]);
    $f = $q->fetch();
    if (!$f) {
        http_response_code(410);
        page_message('Lien expiré', 'Ce fichier n’existe pas ou n’est plus disponible.');
        return;
    }
    header('Cache-Control: no-store');
    if (($_GET['dl'] ?? '') !== '1') {
        $left = $f['max_downloads'] ? max(0, $f['max_downloads'] - $f['downloads']) : null;
        page_head($f['name'] . ' · GLSC');
        ?>
<body class="login-page">
  <main class="login-card file-card">
    <div class="login-logo" aria-hidden="true">↓</div>
    <h1 class="file-name"><?= e($f['name']) ?></h1>
    <p class="login-help"><?= e(human_size((int) $f['size'])) ?> · disponible jusqu’au <?= e(date('d/m/Y à H:i', (int) $f['expires'])) ?>
      <?= $left !== null ? '· ' . e((string) $left) . ' téléchargement' . ($left > 1 ? 's' : '') . ' restant' . ($left > 1 ? 's' : '') : '' ?></p>
    <a class="btn btn-primary" href="/f/<?= e($token) ?>?dl=1" rel="nofollow" download>Télécharger</a>
    <p class="login-foot">Partagé via <a href="https://glsc.fr">glsc.fr</a></p>
  </main>
</body>
</html>
<?php
        return;
    }

    $path = glsc_path('files') . '/' . basename($f['stored']);
    if (!is_file($path)) fail(410, 'Fichier introuvable.');
    if ($method === 'GET') {
        db()->prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?')->execute([$f['id']]);
    }
    // Toujours en pièce jointe, jamais affiché dans le navigateur (un .html ne peut donc pas s'exécuter ici).
    $ascii = preg_replace('/[^A-Za-z0-9._-]+/', '_', $f['name']) ?: 'fichier';
    header('Content-Type: application/octet-stream');
    header("Content-Disposition: attachment; filename=\"$ascii\"; filename*=UTF-8''" . rawurlencode($f['name']));
    header('Content-Security-Policy: sandbox; default-src \'none\'');
    header('Content-Length: ' . filesize($path));
    if ($method === 'HEAD') return;
    if (($_SERVER['GLSC_ADMIN_XACCEL'] ?? getenv('GLSC_ADMIN_XACCEL')) === '1') {
        header('X-Accel-Redirect: /_files/' . rawurlencode(basename($f['stored'])));
        return;
    }
    readfile($path);
}

return [
    'GET files/list' => fn () => ['files' => files_rows(), 'max' => FILE_MAX_BYTES],
    'POST files/upload' => function () {
        $up = $_FILES['file'] ?? null;
        if (!$up || is_array($up['error'])) fail(422, 'Aucun fichier reçu.');
        if ($up['error'] === UPLOAD_ERR_INI_SIZE || $up['error'] === UPLOAD_ERR_FORM_SIZE || $up['size'] > FILE_MAX_BYTES) {
            fail(413, 'Fichier trop gros (200 Mo maximum).');
        }
        if ($up['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($up['tmp_name'])) fail(422, 'Envoi interrompu, réessaie.');
        $ttl = FILE_TTL[$_POST['ttl'] ?? '1d'] ?? fail(422, 'Durée invalide.');
        $max = int_in($_POST, 'max_downloads', null, 1, 1000);
        $name = mb_substr(trim(str_replace(["\0", '/', '\\', "\r", "\n"], '', (string) $up['name'])), 0, 180) ?: 'fichier';
        $stored = bin2hex(random_bytes(16));
        $dir = glsc_path('files');
        if (!is_dir($dir) && !mkdir($dir, 0700, true)) fail(500, 'Dossier de stockage indisponible.');
        if (!move_uploaded_file($up['tmp_name'], "$dir/$stored")) fail(500, 'Impossible d’enregistrer le fichier.');
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file("$dir/$stored") ?: 'application/octet-stream';
        $token = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
        db()->prepare('INSERT INTO files(token, name, size, mime, stored, created, expires, max_downloads) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$token, $name, (int) $up['size'], $mime, $stored, time(), time() + $ttl, $max]);
        return ['files' => files_rows()];
    },
    'POST files/delete' => function () {
        $q = db()->prepare('SELECT stored FROM files WHERE id = ?');
        $id = int_in(body(), 'id', 0);
        $q->execute([$id]);
        if ($stored = $q->fetchColumn()) @unlink(glsc_path('files') . '/' . basename((string) $stored));
        db()->prepare('DELETE FROM files WHERE id = ?')->execute([$id]);
        return ['files' => files_rows()];
    },
];
