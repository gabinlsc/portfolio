<?php
/**
 * Connexion : mot de passe + code 2FA (ou code de secours), sessions et protection CSRF.
 *
 * Les identifiants vivent hors du site, dans /etc/glsc-admin/auth.json (créé par « glsc-admin-setup ») :
 *   {"password_hash": "$argon2id$…", "totp_secret": "BASE32", "recovery": ["sha256…", …]}
 */
declare(strict_types=1);

const SESSION_IDLE = 2 * 3600;        // déconnexion après 2 h sans activité
const SESSION_MAX = 12 * 3600;        // et au plus tard 12 h après la connexion
const LOCK_WINDOW = 15 * 60;          // fenêtre de comptage des échecs
const LOCK_PER_IP = 5;                // échecs tolérés par adresse IP
const LOCK_GLOBAL = 30;               // échecs tolérés toutes adresses confondues

function auth_config(): ?array
{
    $file = glsc_path('auth');
    if (!is_readable($file)) return null;
    $cfg = json_decode((string) file_get_contents($file), true);
    if (!is_array($cfg) || empty($cfg['password_hash']) || empty($cfg['totp_secret'])) return null;
    $cfg['recovery'] = array_values(array_filter((array) ($cfg['recovery'] ?? []), 'is_string'));
    return $cfg;
}

function insecure_dev(): bool
{
    return getenv('GLSC_ADMIN_INSECURE') === '1';
}

function session_boot(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $secure = !insecure_dev();
    session_name($secure ? '__Host-glsc_admin' : 'glsc_admin');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', (string) SESSION_MAX);
    ini_set('session.sid_length', '48');
    ini_set('session.sid_bits_per_character', '6');
    session_start();
}

/** Session valide et non expirée ? Met à jour l'heure de dernière activité. */
function logged_in(): bool
{
    session_boot();
    $s = $_SESSION;
    if (empty($s['uid']) || empty($s['login_at']) || empty($s['seen'])) return false;
    $now = time();
    if ($now - $s['seen'] > SESSION_IDLE || $now - $s['login_at'] > SESSION_MAX || ($s['ua'] ?? '') !== hash('sha256', user_agent())) {
        logout(false);
        return false;
    }
    $_SESSION['seen'] = $now;
    return true;
}

function csrf_token(): string
{
    session_boot();
    return $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
}

/** Requêtes qui modifient quelque chose : jeton CSRF en en-tête + même origine. */
function csrf_check(): void
{
    $sent = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($sent === '' || !hash_equals(csrf_token(), $sent)) fail(403, 'Jeton de sécurité invalide, recharge la page.');
    $site = (string) ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'same-origin');
    if (!in_array($site, ['same-origin', 'none'], true)) fail(403, 'Requête refusée (origine).');
}

function admin_log(string $event): void
{
    db()->prepare('INSERT INTO admin_log(at, ip, ua, event) VALUES(?, ?, ?, ?)')->execute([time(), client_ip(), user_agent(), $event]);
}

/** Secondes avant de pouvoir réessayer, 0 si la connexion est permise. */
function lock_remaining(): int
{
    $since = time() - LOCK_WINDOW;
    $q = db()->prepare('SELECT COUNT(*) n, MIN(at) first FROM login_attempts WHERE ok = 0 AND at > ? AND ip = ?');
    $q->execute([$since, client_ip()]);
    $ip = $q->fetch();
    $q = db()->prepare('SELECT COUNT(*) n, MIN(at) first FROM login_attempts WHERE ok = 0 AND at > ?');
    $q->execute([$since]);
    $all = $q->fetch();
    $wait = 0;
    if ($ip['n'] >= LOCK_PER_IP) $wait = max($wait, (int) $ip['first'] + LOCK_WINDOW - time());
    if ($all['n'] >= LOCK_GLOBAL) $wait = max($wait, (int) $all['first'] + LOCK_WINDOW - time());
    return max(0, $wait);
}

/**
 * Tente une connexion. Renvoie null si réussie, sinon le message d'erreur à afficher.
 * Le code peut être un code 2FA à 6 chiffres ou un code de secours (xxxx-xxxx-xxxx).
 */
function login(string $password, string $code): ?string
{
    $cfg = auth_config();
    if (!$cfg) return glsc_instance() === 'gst'
        ? 'Admin pro pas encore configurée : lance « glsc-admin-setup --gst » sur le serveur.'
        : 'Admin pas encore configurée : lance « glsc-admin-setup » sur le serveur.';
    if (($wait = lock_remaining()) > 0) {
        return sprintf('Trop d’essais. Réessaie dans %d min.', (int) ceil($wait / 60));
    }

    $code = strtolower(preg_replace('/\s+/', '', $code));
    $okPassword = password_verify($password, $cfg['password_hash']);
    $method = null;
    if ($okPassword) {
        if (preg_match('/^\d{6}$/', $code)) {
            $key = 'totp_last_' . substr(hash('sha256', $cfg['totp_secret']), 0, 12); // remis à zéro si le secret change
            $counter = totp_verify($cfg['totp_secret'], $code, (int) setting($key, '-1'));
            if ($counter !== null) {
                set_setting($key, (string) $counter);
                $method = 'code 2FA';
            }
        } elseif (preg_match('/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/', $code)) {
            $hash = hash('sha256', $code);
            $used = db()->prepare('SELECT 1 FROM recovery_used WHERE hash = ?');
            $used->execute([$hash]);
            if (in_array($hash, $cfg['recovery'], true) && !$used->fetchColumn()) {
                db()->prepare('INSERT INTO recovery_used(hash, at) VALUES(?, ?)')->execute([$hash, time()]);
                $method = 'code de secours';
            }
        }
    }

    db()->prepare('INSERT INTO login_attempts(ip, at, ok) VALUES(?, ?, ?)')->execute([client_ip(), time(), $method ? 1 : 0]);
    db()->prepare('DELETE FROM login_attempts WHERE at < ?')->execute([time() - 30 * 86400]);

    if (!$method) {
        admin_log($okPassword ? 'échec : code 2FA refusé' : 'échec : mot de passe refusé');
        usleep(random_int(300_000, 700_000));
        if (lock_remaining() > 0) notify('login_fail', '🔒 Admin verrouillée', 'Trop d’essais de connexion depuis ' . client_ip() . '.');
        return 'Mot de passe ou code incorrect.';
    }

    session_boot();
    session_regenerate_id(true);
    $_SESSION = ['uid' => 1, 'login_at' => time(), 'seen' => time(), 'ua' => hash('sha256', user_agent()), 'csrf' => bin2hex(random_bytes(32))];
    admin_log("connexion ($method)");
    notify('login', glsc_instance() === 'gst' ? '🔑 Connexion à l’admin pro' : '🔑 Connexion à l’admin', sprintf("Depuis %s (%s)%s", client_ip(), device_of(user_agent()),
        $method === 'code de secours' ? "\nAvec un code de secours : pense à en régénérer." : ''));
    return null;
}

function logout(bool $log = true): void
{
    session_boot();
    if ($log && !empty($_SESSION['uid'])) admin_log('déconnexion');
    $_SESSION = [];
    $p = session_get_cookie_params();
    setcookie(session_name(), '', ['expires' => 1, 'path' => $p['path'], 'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Strict']);
    session_destroy();
}

function recovery_left(): int
{
    $cfg = auth_config();
    if (!$cfg) return 0;
    $used = array_column(db()->query('SELECT hash FROM recovery_used')->fetchAll(), 'hash');
    return count(array_diff($cfg['recovery'], $used));
}
