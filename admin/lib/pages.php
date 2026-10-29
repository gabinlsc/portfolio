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

function is_gst(): bool
{
    return glsc_instance() === 'gst';
}

/** Nom affiché de l'instance. */
function site_name(): string
{
    return is_gst() ? 'Admin pro' : 'Admin GLSC';
}

function page_head(string $title, bool $csrf = false): void
{
    $gst = is_gst();
    ?><!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="<?= $gst ? '#2447D6' : '#FFFDF0' ?>" />
  <meta name="glsc-instance" content="<?= $gst ? 'gst' : 'admin' ?>" />
<?php if ($csrf): ?>
  <meta name="csrf-token" content="<?= e(csrf_token()) ?>" />
<?php endif; ?>
  <title><?= e($title) ?></title>
  <link rel="icon" href="/assets/<?= $gst ? 'favicon-gst.svg' : 'favicon.svg' ?>" type="image/svg+xml" />
<?php if ($gst): ?>
  <link rel="stylesheet" href="<?= asset('/assets/admin.css') ?>" />
  <link rel="stylesheet" href="<?= asset('/assets/gst.css') ?>" />
<?php else: ?>
  <link rel="stylesheet" href="<?= asset('/_glsc/fonts.css') ?>" />
  <link rel="stylesheet" href="<?= asset('/assets/admin.css') ?>" />
<?php endif; ?>
</head>
<?php
}

function page_app(): void
{
    page_head(is_gst() ? 'Admin pro · StudioGLSC' : 'Admin · GLSC', true);
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
    page_head('Connexion · ' . site_name(), true);
    $gst = is_gst();
    ?>
<body class="login-page">
  <main class="login-card">
<?php if ($gst): ?>
    <img class="logo-img logo-light" src="/assets/gst-logo.svg" alt="StudioGLSC" />
    <img class="logo-img logo-dark" src="/assets/gst-logo-sombre.svg" alt="" />
<?php else: ?>
    <div class="login-logo" aria-hidden="true">G</div>
<?php endif; ?>
    <h1><?= $gst ? 'Admin pro' : 'Espace privé' ?></h1>
    <?php if (!$configured): ?>
      <p class="login-help"><?= $gst ? 'L’admin pro n’est pas encore configurée' : 'L’admin n’est pas encore configurée' ?>. Sur le serveur, lance :</p>
      <pre class="code"><?= $gst ? 'glsc-admin-setup --gst' : 'glsc-admin-setup' ?></pre>
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
    <p class="login-foot"><?= $gst ? '<a href="https://studio.glsc.fr">← studio.glsc.fr</a>' : '<a href="https://glsc.fr">← glsc.fr</a>' ?></p>
  </main>
  <script src="<?= asset('/assets/login.js') ?>"></script>
</body>
</html>
<?php
}

function page_message(string $title, string $text): void
{
    page_head($title . ' · ' . site_name());
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
