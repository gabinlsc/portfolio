<?php
/** Codes à 6 chiffres (TOTP, RFC 6238) compatibles Google Authenticator, Aegis, 2FAS… */
declare(strict_types=1);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32_encode(string $bin): string
{
    $bits = '';
    foreach (str_split($bin) as $c) $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
    $out = '';
    foreach (str_split($bits, 5) as $chunk) $out .= B32[bindec(str_pad($chunk, 5, '0'))];
    return $out;
}

function base32_decode(string $b32): string
{
    $b32 = strtoupper(preg_replace('/[\s=-]/', '', $b32));
    $bits = '';
    foreach (str_split($b32) as $c) {
        $i = strpos(B32, $c);
        if ($i === false) throw new InvalidArgumentException('secret base32 invalide');
        $bits .= str_pad(decbin($i), 5, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 8) as $byte) if (strlen($byte) === 8) $out .= chr(bindec($byte));
    return $out;
}

function hotp(string $key, int $counter): string
{
    $hash = hash_hmac('sha1', pack('J', $counter), $key, true);
    $offset = ord($hash[19]) & 0x0f;
    $value = (unpack('N', substr($hash, $offset, 4))[1] & 0x7fffffff) % 1_000_000;
    return str_pad((string) $value, 6, '0', STR_PAD_LEFT);
}

/**
 * Vérifie un code (tolère ±30 s de décalage d'horloge).
 * Renvoie le compteur accepté, ou null. Un compteur ≤ $last (déjà utilisé) est refusé : pas de rejeu.
 */
function totp_verify(string $secret, string $code, int $last = -1, ?int $now = null): ?int
{
    if (!preg_match('/^\d{6}$/', $code)) return null;
    $key = base32_decode($secret);
    $t = intdiv($now ?? time(), 30);
    foreach ([0, -1, 1] as $d) {
        $counter = $t + $d;
        if ($counter > $last && hash_equals(hotp($key, $counter), $code)) return $counter;
    }
    return null;
}
