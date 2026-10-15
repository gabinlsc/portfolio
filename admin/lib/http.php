<?php
/** Réponses HTTP, en-têtes de sécurité et validation des entrées. */
declare(strict_types=1);

final class HttpError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function fail(int $status, string $message): never
{
    throw new HttpError($status, $message);
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

function user_agent(): string
{
    return mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 300);
}

/** En-têtes communs : nginx n'ajoute rien sur ce site, tout est envoyé ici. */
function security_headers(): void
{
    header_remove('X-Powered-By');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
        . "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Strict-Transport-Security: max-age=31536000');
}

function json_out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Corps JSON de la requête (objet), 1 Mo maximum. */
function body(): array
{
    static $data = null;
    if ($data !== null) return $data;
    $raw = file_get_contents('php://input', false, null, 0, 1_048_577);
    if ($raw === false || strlen($raw) > 1_048_576) fail(413, 'Requête trop volumineuse.');
    if ($raw === '') return $data = [];
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) fail(400, 'JSON invalide.');
    return $data = $decoded;
}

/** Texte obligatoire ou facultatif, nettoyé et borné. */
function str_in(array $src, string $key, int $max = 200, bool $required = false, string $default = ''): string
{
    $v = $src[$key] ?? null;
    if ($v === null || $v === '') {
        if ($required) fail(422, "Champ « $key » manquant.");
        return $default;
    }
    if (!is_string($v) && !is_int($v) && !is_float($v)) fail(422, "Champ « $key » invalide.");
    $v = trim(str_replace("\0", '', (string) $v));
    if ($required && $v === '') fail(422, "Champ « $key » vide.");
    if (mb_strlen($v) > $max) fail(422, "Champ « $key » trop long ($max caractères maximum).");
    return $v;
}

function int_in(array $src, string $key, ?int $default = null, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): ?int
{
    $v = $src[$key] ?? null;
    if ($v === null || $v === '') return $default;
    if (!is_numeric($v) || (int) $v != $v) fail(422, "Champ « $key » : nombre entier attendu.");
    $v = (int) $v;
    if ($v < $min || $v > $max) fail(422, "Champ « $key » hors limites.");
    return $v;
}

function bool_in(array $src, string $key, bool $default = false): bool
{
    $v = $src[$key] ?? null;
    return $v === null ? $default : filter_var($v, FILTER_VALIDATE_BOOL);
}

/** URL http(s) uniquement (pas de javascript:, data:, etc.). */
function url_in(array $src, string $key, bool $required = true): string
{
    $v = str_in($src, $key, 2000, $required);
    if ($v === '') return '';
    $parts = parse_url($v);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true) || empty($parts['host'])) {
        fail(422, "Champ « $key » : adresse http(s) attendue.");
    }
    return $v;
}

/** Date AAAA-MM-JJ ou AAAA-MM-JJTHH:MM. */
function date_in(array $src, string $key, bool $required = false): ?string
{
    $v = str_in($src, $key, 16, $required);
    if ($v === '') return null;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/', $v)) fail(422, "Champ « $key » : date invalide.");
    return $v;
}

function enum_in(array $src, string $key, array $allowed, string $default): string
{
    $v = $src[$key] ?? $default;
    if (!is_string($v) || !in_array($v, $allowed, true)) fail(422, "Champ « $key » invalide.");
    return $v;
}

const COLORS = ['paper', 'banana', 'mint', 'lilac', 'sky', 'coral', 'peach'];

/** Appareil déduit du User-Agent : mobile, tablette, ordinateur ou robot. */
function device_of(string $ua): string
{
    if ($ua === '' || preg_match('/bot|crawl|spider|slurp|curl|wget|python|httpclient|preview|facebookexternalhit|discord|whatsapp/i', $ua)) return 'robot';
    if (preg_match('/ipad|tablet/i', $ua)) return 'tablette';
    if (preg_match('/mobi|android|iphone/i', $ua)) return 'mobile';
    return 'ordinateur';
}
