<?php
/** Pages HTML : coquille de l'application, connexion, message d'erreur. */
declare(strict_types=1);

function e(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function asset(string $path): string
{
    $file = ($_SERVER['DOCUMENT_ROOT'] ?? '') . $path;
    $v = is_file($file) ? substr(md5((string) filemtime($file)), 0, 8) : GLSC_VERSION;
    return e($path . '?v=' . $v);
}

function page_head(string $title, bool $csrf = false): void
{
    ?><!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#FFFDF0" />
<?php if ($csrf): ?>
  <meta name="csrf-token" content="<?= e(csrf_token()) ?>" />
<?php endif; ?>
  <title><?= e($title) ?></title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="<?= asset('/_glsc/fonts.css') ?>" />
  <link rel="stylesheet" href="<?= asset('/assets/admin.css') ?>" />
</head>
<?php
}

function page_app(): void
{
    page_head('Admin · GLSC', true);
    ?>
<body class="app">
  <div id="app" aria-live="polite"><p class="boot">Chargement…</p></div>
  <script type="module" src="<?= asset('/assets/app.js') ?>"></script>
</body>
</html>
<?php
}

function page_login(): void
{
    $configured = auth_config() !== null;
    page_head('Connexion · Admin GLSC', true);
    ?>
<body class="login-page">
  <main class="login-card">
    <div class="login-logo" aria-hidden="true">G</div>
    <h1>Espace privé</h1>
    <?php if (!$configured): ?>
      <p class="login-help">L’admin n’est pas encore configurée. Sur le serveur, lance :</p>
      <pre class="code">glsc-admin-setup</pre>
    <?php else: ?>
      <form id="login" class="stack" autocomplete="on">
        <label class="field"><span>Mot de passe</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <label class="field"><span>Code 2FA</span>
          <input class="input code-input" type="text" name="code" inputmode="numeric" autocomplete="one-time-code"
                 placeholder="123456" maxlength="14" required /></label>
        <p class="hint">Code à 6 chiffres de ton appli, ou un code de secours (xxxx-xxxx-xxxx).</p>
        <p class="error" id="login-error" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Se connecter</button>
      </form>
    <?php endif; ?>
    <p class="login-foot"><a href="https://glsc.fr">← glsc.fr</a></p>
  </main>
  <script src="<?= asset('/assets/login.js') ?>"></script>
</body>
</html>
<?php
}

function page_message(string $title, string $text): void
{
    page_head($title . ' · Admin GLSC');
    ?>
<body class="login-page">
  <main class="login-card">
    <h1><?= e($title) ?></h1>
    <p class="login-help"><?= e($text) ?></p>
    <p class="login-foot"><a href="/">← Retour</a></p>
  </main>
</body>
</html>
<?php
}
