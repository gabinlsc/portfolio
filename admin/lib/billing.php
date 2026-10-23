<?php
/**
 * Devis et factures (micro-entreprise, clients professionnels, TVA non applicable - art. 293 B du CGI).
 * Fonctions sans HTTP : testables avec admin/tests/billing_test.php.
 *
 * Règles :
 *  - un brouillon se modifie et se supprime ; un document « émis » reçoit son numéro (D-AAAA-NNN, F-AAAA-NNN, A-AAAA-NNN, sans trou) et un instantané
 *    figé de l'identité du vendeur, du client et des lignes : il ne change plus jamais (on corrige une facture par un avoir) ;
 *  - tous les montants sont en centimes (entiers).
 */
declare(strict_types=1);

const BILL_PREFIX = ['quote' => 'D', 'invoice' => 'F', 'credit' => 'A'];
const BILL_MAX_LINES = 40;
const BILL_MAX_CENTS = 100_000_000_00; // 100 millions d'euros : garde-fou contre les fautes de frappe

/** Montant en centimes → « 1 234,56 € » (espaces insécables). */
function bill_eur(int $cents): string
{
    $neg = $cents < 0;
    $cents = abs($cents);
    $int = number_format(intdiv($cents, 100), 0, '', "\u{202F}");
    $dec = $cents % 100;
    return ($neg ? '−' : '') . $int . ($dec ? ',' . sprintf('%02d', $dec) : '') . "\u{00A0}€";
}

/** Total d'une ligne en centimes : quantité (2 décimales) × prix unitaire, arrondi au centime. */
function bill_line_total(array $line): int
{
    $qty100 = (int) round(((float) $line['qty']) * 100);
    return intdiv($qty100 * (int) $line['unit'] + ($qty100 * (int) $line['unit'] >= 0 ? 50 : -50), 100);
}

function bill_total(array $lines): int
{
    return array_sum(array_map('bill_line_total', $lines));
}

/** Valide et normalise les lignes envoyées par l'interface. */
function bill_clean_lines(mixed $raw): array
{
    if (!is_array($raw) || count($raw) > BILL_MAX_LINES) fail(422, 'Lignes invalides (40 au maximum).');
    $out = [];
    foreach ($raw as $l) {
        if (!is_array($l)) fail(422, 'Ligne invalide.');
        $desc = trim(str_replace("\0", '', (string) ($l['desc'] ?? '')));
        if ($desc === '' && (($l['unit'] ?? '') === '' || ($l['unit'] ?? 0) == 0)) continue; // ligne vide ignorée
        if ($desc === '' || mb_strlen($desc) > 300) fail(422, 'Chaque ligne doit avoir une description (300 caractères au maximum).');
        $qty = $l['qty'] ?? 1;
        if (!is_numeric($qty) || (float) $qty <= 0 || (float) $qty > 9999) fail(422, "Quantité invalide pour « $desc ».");
        $unit = $l['unit'] ?? 0;
        if (!is_numeric($unit) || (int) $unit != $unit || abs((int) $unit) > BILL_MAX_CENTS) fail(422, "Prix invalide pour « $desc ».");
        $out[] = ['desc' => $desc, 'qty' => round((float) $qty, 2), 'unit' => (int) $unit, 'unitLabel' => mb_substr(trim((string) ($l['unitLabel'] ?? '')), 0, 20)];
    }
    if (abs(bill_total($out)) > BILL_MAX_CENTS) fail(422, 'Montant total trop élevé.');
    return $out;
}

/** Clé de contrôle de Luhn (SIREN : 9 chiffres, SIRET : 14 chiffres). */
function bill_luhn(string $digits): bool
{
    if ($digits === '' || !ctype_digit($digits)) return false;
    $sum = 0;
    foreach (array_reverse(str_split($digits)) as $i => $d) {
        $n = (int) $d * ($i % 2 ? 2 : 1);
        $sum += $n > 9 ? $n - 9 : $n;
    }
    return $sum % 10 === 0;
}

function bill_siren_ok(string $v): bool { return strlen($v) === 9 && bill_luhn($v); }
function bill_siret_ok(string $v): bool { return strlen($v) === 14 && bill_luhn($v); }

/** Supprime les espaces d'un numéro (SIREN, SIRET, IBAN). */
function bill_digits(string $v): string { return preg_replace('/\s+/', '', $v) ?? ''; }

// ---------------------------------------------------------------- vendeur (réglages)

const BILL_SELLER_DEFAULTS = [
    'name' => 'Gabin Lescoat', 'brand' => 'StudioGLSC', 'siren' => '', 'siret' => '', 'address' => '', 'postcode' => '', 'city' => '',
    'email' => 'pro@glsc.fr', 'phone' => '+33 7 67 20 44 24', 'iban' => '', 'bic' => '', 'bank' => '',
    'pay_days' => '30', 'valid_days' => '30', 'deposit' => '50', 'ca_limit' => '77700', 'footer' => '',
];

function bill_seller(): array
{
    $out = [];
    foreach (BILL_SELLER_DEFAULTS as $k => $default) $out[$k] = (string) setting('billing_' . $k, $default);
    return $out;
}

/** Ce qu'il manque pour pouvoir émettre un document (libellés lisibles). */
function bill_seller_missing(array $s): array
{
    $m = [];
    if ($s['name'] === '') $m[] = 'ton nom';
    if (!bill_siret_ok(bill_digits($s['siret']))) $m[] = 'ton SIRET (14 chiffres valides)';
    if ($s['address'] === '' || $s['postcode'] === '' || $s['city'] === '') $m[] = 'l’adresse du siège';
    if ($s['email'] === '') $m[] = 'ton e-mail';
    return $m;
}

function bill_save_seller(array $b): array
{
    $max = ['name' => 80, 'brand' => 80, 'siren' => 14, 'siret' => 20, 'address' => 160, 'postcode' => 10, 'city' => 80, 'email' => 120, 'phone' => 30,
        'iban' => 50, 'bic' => 15, 'bank' => 80, 'footer' => 400];
    $out = [];
    foreach ($max as $k => $len) $out[$k] = str_in($b, $k, $len);
    $out['siren'] = bill_digits($out['siren']);
    $out['siret'] = bill_digits($out['siret']);
    $out['iban'] = strtoupper(bill_digits($out['iban']));
    $out['bic'] = strtoupper(bill_digits($out['bic']));
    if ($out['siren'] !== '' && !bill_siren_ok($out['siren'])) fail(422, 'SIREN invalide (9 chiffres, clé de contrôle incorrecte).');
    if ($out['siret'] !== '' && !bill_siret_ok($out['siret'])) fail(422, 'SIRET invalide (14 chiffres, clé de contrôle incorrecte).');
    if ($out['siren'] === '' && $out['siret'] !== '') $out['siren'] = substr($out['siret'], 0, 9);
    if ($out['siret'] !== '' && $out['siren'] !== substr($out['siret'], 0, 9)) fail(422, 'Le SIRET doit commencer par le SIREN.');
    if ($out['email'] !== '' && !filter_var($out['email'], FILTER_VALIDATE_EMAIL)) fail(422, 'E-mail invalide.');
    $out['pay_days'] = (string) int_in($b, 'pay_days', 30, 0, 60);                // 60 jours : plafond légal entre professionnels
    $out['valid_days'] = (string) int_in($b, 'valid_days', 30, 1, 365);
    $out['deposit'] = (string) int_in($b, 'deposit', 50, 0, 100);
    $out['ca_limit'] = (string) int_in($b, 'ca_limit', 77700, 0, 10_000_000);
    foreach ($out as $k => $v) set_setting('billing_' . $k, $v);
    return bill_seller();
}

// ---------------------------------------------------------------- clients

function bill_client_row(array $b): array
{
    $siren = bill_digits(str_in($b, 'siren', 14));
    if ($siren !== '' && !bill_siren_ok($siren)) fail(422, 'SIREN du client invalide (9 chiffres, clé de contrôle incorrecte).');
    $email = str_in($b, 'email', 120);
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) fail(422, 'E-mail du client invalide.');
    return [
        'name' => str_in($b, 'name', 120, true), 'contact' => str_in($b, 'contact', 80), 'siren' => $siren, 'vat_id' => strtoupper(bill_digits(str_in($b, 'vat_id', 20))),
        'address' => str_in($b, 'address', 160), 'postcode' => str_in($b, 'postcode', 10), 'city' => str_in($b, 'city', 80), 'country' => str_in($b, 'country', 60, false, 'France'),
        'email' => $email, 'phone' => str_in($b, 'phone', 30), 'note' => str_in($b, 'note', 500),
    ];
}

function bill_client(int $id): array
{
    $st = db()->prepare('SELECT * FROM bill_clients WHERE id = ?');
    $st->execute([$id]);
    $c = $st->fetch();
    if (!$c) fail(404, 'Client introuvable.');
    return $c;
}

// ---------------------------------------------------------------- documents

function bill_doc(int $id): array
{
    $st = db()->prepare('SELECT * FROM bill_docs WHERE id = ?');
    $st->execute([$id]);
    $d = $st->fetch();
    if (!$d) fail(404, 'Document introuvable.');
    return $d;
}

/** Prochain numéro d'une série (à appeler dans une transaction qui verrouille l'écriture). */
function bill_next_number(PDO $pdo, string $kind, int $year): array
{
    $st = $pdo->prepare('SELECT COALESCE(MAX(seq), 0) FROM bill_docs WHERE kind = ? AND year = ?');
    $st->execute([$kind, $year]);
    $seq = (int) $st->fetchColumn() + 1;
    return [$seq, sprintf('%s-%d-%03d', BILL_PREFIX[$kind], $year, $seq)];
}

function bill_add_days(string $date, int $days): string
{
    return (new DateTimeImmutable($date))->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
}

/** Crée ou met à jour un brouillon. Renvoie l'identifiant. */
function bill_save_draft(array $b, string $today): int
{
    $pdo = db();
    $id = int_in($b, 'id', 0, 0) ?? 0;
    $kind = str_in($b, 'kind', 10, true);
    if (!in_array($kind, ['quote', 'invoice'], true)) fail(422, 'Type de document inconnu.');
    $clientId = int_in($b, 'client_id', 0, 1);
    if (!$clientId) fail(422, 'Choisis un client.');
    $client = bill_client($clientId);
    $fields = [
        'client_id' => (int) $client['id'], 'subject' => str_in($b, 'subject', 160), 'delivery' => str_in($b, 'delivery', 300), 'notes' => str_in($b, 'notes', 1000),
        'deposit_percent' => int_in($b, 'deposit_percent', (int) setting('billing_deposit', '50'), 0, 100),
        'terms_days' => int_in($b, 'terms_days', (int) setting($kind === 'quote' ? 'billing_valid_days' : 'billing_pay_days', '30'), 0, 365),
        'service_date' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($b['service_date'] ?? '')) ? (string) $b['service_date'] : null,
    ];
    $lines = bill_clean_lines($b['lines'] ?? []);
    $fields['lines'] = json_encode($lines, JSON_UNESCAPED_UNICODE);
    $fields['total'] = bill_total($lines);
    $now = time();
    if ($id) {
        $doc = bill_doc($id);
        if ($doc['status'] !== 'draft') fail(409, 'Un document émis ne peut plus être modifié.');
        $set = implode(', ', array_map(fn ($k) => "$k = :$k", array_keys($fields)));
        $pdo->prepare("UPDATE bill_docs SET $set, updated = :updated WHERE id = :id")->execute($fields + ['updated' => $now, 'id' => $id]);
        return $id;
    }
    $cols = array_merge(['kind', 'issue_date', 'created', 'updated'], array_keys($fields));
    $pdo->prepare('INSERT INTO bill_docs(' . implode(', ', $cols) . ') VALUES(' . implode(', ', array_map(fn ($c) => ':' . $c, $cols)) . ')')
        ->execute($fields + ['kind' => $kind, 'issue_date' => $today, 'created' => $now, 'updated' => $now]);
    return (int) $pdo->lastInsertId();
}

/** Émet un brouillon : numéro, dates, instantané figé. */
function bill_issue(int $id, string $today): array
{
    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $doc = bill_doc($id);
        if ($doc['status'] !== 'draft') fail(409, 'Ce document est déjà émis.');
        $seller = bill_seller();
        $missing = bill_seller_missing($seller);
        if ($missing) fail(422, 'Avant d’émettre un document, renseigne dans l’onglet Réglages : ' . implode(', ', $missing) . '.');
        $lines = json_decode((string) $doc['lines'], true) ?: [];
        if (!$lines) fail(422, 'Ajoute au moins une ligne.');
        $total = bill_total($lines);
        if ($doc['kind'] === 'quote' && $total <= 0) fail(422, 'Le total d’un devis doit être positif.');
        if ($doc['kind'] === 'credit' && $total >= 0) fail(422, 'Un avoir doit avoir un total négatif.');
        $client = bill_client((int) $doc['client_id']);
        $year = (int) substr($today, 0, 4);
        if ($doc['kind'] !== 'quote') { // numérotation chronologique : pas d'antidatage par rapport au dernier document de la série
            $last = $pdo->prepare('SELECT MAX(issue_date) FROM bill_docs WHERE kind = ? AND seq IS NOT NULL');
            $last->execute([$doc['kind']]);
            $d = (string) $last->fetchColumn();
            if ($d !== '' && $d > $today) fail(422, "Le dernier document de cette série date du $d : impossible d'émettre avec une date antérieure.");
        }
        [$seq, $number] = bill_next_number($pdo, (string) $doc['kind'], $year);
        $terms = (int) $doc['terms_days'];
        $valid = $doc['kind'] === 'quote' ? bill_add_days($today, $terms) : null;
        $due = $doc['kind'] === 'invoice' ? bill_add_days($today, $doc['subtype'] === 'deposit' ? 0 : $terms) : null;
        $snapshot = ['seller' => $seller, 'client' => $client, 'lines' => $lines, 'total' => $total, 'issue_date' => $today, 'valid_until' => $valid, 'due_date' => $due];
        $parent = $doc['parent_id'] ? bill_doc((int) $doc['parent_id']) : null;
        if ($parent) $snapshot['parent'] = ['number' => $parent['number'], 'kind' => $parent['kind'], 'issue_date' => $parent['issue_date']];
        $pdo->prepare('UPDATE bill_docs SET number = ?, year = ?, seq = ?, status = ?, issue_date = ?, valid_until = ?, due_date = ?, snapshot = ?, total = ?, updated = ? WHERE id = ?')
            ->execute([$number, $year, $seq, 'issued', $today, $valid, $due, json_encode($snapshot, JSON_UNESCAPED_UNICODE), $total, time(), $id]);
        if ($doc['kind'] === 'credit' && $parent) $pdo->prepare("UPDATE bill_docs SET status = 'credited', updated = ? WHERE id = ?")->execute([time(), $parent['id']]);
        $pdo->exec('COMMIT');
        return ['id' => $id, 'number' => $number];
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

/** Facture d'acompte, de solde ou complète à partir d'un devis émis ; renvoie l'identifiant du brouillon. */
function bill_derive_invoice(int $quoteId, string $subtype, string $today): int
{
    $q = bill_doc($quoteId);
    if ($q['kind'] !== 'quote' || !in_array($q['status'], ['issued', 'accepted'], true)) fail(409, 'Il faut partir d’un devis émis.');
    $pdo = db();
    $siblings = $pdo->prepare("SELECT * FROM bill_docs WHERE parent_id = ? AND kind = 'invoice' AND status <> 'credited' ORDER BY id");
    $siblings->execute([$quoteId]);
    $existing = $siblings->fetchAll();
    $qLines = json_decode((string) $q['lines'], true) ?: [];
    $qTotal = bill_total($qLines);
    $number = (string) $q['number'];
    $deposits = array_values(array_filter($existing, fn ($d) => $d['subtype'] === 'deposit'));
    if ($subtype === 'deposit') {
        if ($existing) fail(409, 'Ce devis a déjà une facture : l’acompte se facture en premier.');
        $pct = (int) $q['deposit_percent'];
        if ($pct <= 0 || $pct >= 100) fail(422, 'Pourcentage d’acompte invalide pour ce devis.');
        $amount = intdiv($qTotal * $pct + 50, 100);
        $lines = [['desc' => "Acompte de $pct % à la commande — devis $number", 'qty' => 1.0, 'unit' => $amount, 'unitLabel' => '']];
    } elseif ($subtype === 'balance') {
        if (!$deposits) fail(409, 'Aucune facture d’acompte émise pour ce devis : utilise « Facture complète ».');
        foreach ($deposits as $d) if ($d['status'] === 'draft') fail(409, 'Émets d’abord la facture d’acompte.');
        $lines = $qLines;
        foreach ($deposits as $d) $lines[] = ['desc' => 'Acompte déjà facturé — facture ' . $d['number'], 'qty' => 1.0, 'unit' => -(int) $d['total'], 'unitLabel' => ''];
    } elseif ($subtype === 'full') {
        if ($existing) fail(409, 'Ce devis a déjà une facture : utilise « Facture de solde ».');
        $lines = $qLines;
    } else {
        fail(422, 'Type de facture inconnu.');
    }
    $now = time();
    $pdo->prepare("INSERT INTO bill_docs(kind, status, client_id, parent_id, subtype, subject, issue_date, deposit_percent, terms_days, delivery, notes, lines, total, created, updated)
        VALUES('invoice', 'draft', ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)")
        ->execute([$q['client_id'], $quoteId, $subtype, $q['subject'], $today, $q['deposit_percent'], (int) setting('billing_pay_days', '30'),
            json_encode($lines, JSON_UNESCAPED_UNICODE), bill_total($lines), $now, $now]);
    return (int) $pdo->lastInsertId();
}

/** Avoir qui annule une facture émise (lignes de la facture, montants inversés). */
function bill_derive_credit(int $invoiceId, string $today): int
{
    $inv = bill_doc($invoiceId);
    if ($inv['kind'] !== 'invoice' || !in_array($inv['status'], ['issued', 'paid'], true)) fail(409, 'Un avoir se crée à partir d’une facture émise.');
    $pdo = db();
    $c = $pdo->prepare("SELECT COUNT(*) FROM bill_docs WHERE kind = 'credit' AND parent_id = ?");
    $c->execute([$invoiceId]);
    if ((int) $c->fetchColumn() > 0) fail(409, 'Cette facture a déjà un avoir.');
    $lines = array_map(fn ($l) => ['desc' => $l['desc'], 'qty' => $l['qty'], 'unit' => -$l['unit'], 'unitLabel' => $l['unitLabel'] ?? ''], json_decode((string) $inv['lines'], true) ?: []);
    $now = time();
    $pdo->prepare("INSERT INTO bill_docs(kind, status, client_id, parent_id, subtype, subject, issue_date, terms_days, lines, total, created, updated)
        VALUES('credit', 'draft', ?, ?, 'full', ?, ?, 0, ?, ?, ?, ?)")
        ->execute([$inv['client_id'], $invoiceId, 'Annulation de la facture ' . $inv['number'], $today, json_encode($lines, JSON_UNESCAPED_UNICODE), bill_total($lines), $now, $now]);
    return (int) $pdo->lastInsertId();
}

const BILL_TRANSITIONS = [
    'quote' => ['issued' => ['accepted', 'refused'], 'accepted' => ['issued'], 'refused' => ['issued']],
    'invoice' => ['issued' => ['paid'], 'paid' => ['issued']],
];

function bill_set_status(int $id, string $status, string $paidAt, string $method): void
{
    $doc = bill_doc($id);
    $allowed = BILL_TRANSITIONS[$doc['kind']][$doc['status']] ?? [];
    if (!in_array($status, $allowed, true)) fail(409, 'Changement de statut impossible depuis « ' . $doc['status'] . ' ».');
    if ($status === 'paid') {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $paidAt)) fail(422, 'Date de paiement invalide.');
        db()->prepare('UPDATE bill_docs SET status = ?, paid_at = ?, paid_method = ?, updated = ? WHERE id = ?')->execute([$status, $paidAt, mb_substr($method, 0, 30), time(), $id]);
        return;
    }
    db()->prepare('UPDATE bill_docs SET status = ?, paid_at = NULL, paid_method = ?, updated = ? WHERE id = ?')->execute([$status, '', time(), $id]);
}

function bill_delete_draft(int $id): void
{
    $doc = bill_doc($id);
    if ($doc['status'] !== 'draft') fail(409, 'Seuls les brouillons se suppriment (un document émis se conserve 10 ans).');
    db()->prepare('DELETE FROM bill_docs WHERE id = ?')->execute([$id]);
}

/** Copie d'un devis en brouillon (nouvelle date, mêmes lignes). */
function bill_duplicate(int $id, string $today): int
{
    $d = bill_doc($id);
    if ($d['kind'] !== 'quote') fail(409, 'Seuls les devis se dupliquent.');
    $now = time();
    db()->prepare("INSERT INTO bill_docs(kind, status, client_id, subject, issue_date, deposit_percent, terms_days, delivery, notes, lines, total, created, updated)
        VALUES('quote', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        ->execute([$d['client_id'], $d['subject'], $today, $d['deposit_percent'], $d['terms_days'], $d['delivery'], $d['notes'], $d['lines'], $d['total'], $now, $now]);
    return (int) db()->lastInsertId();
}

/** Ligne de liste : ce qu'il faut pour un tableau (pas de lignes de détail). */
function bill_summary(array $d, array $clients, array $numbers): array
{
    $expired = $d['kind'] === 'quote' && $d['status'] === 'issued' && $d['valid_until'] && $d['valid_until'] < date('Y-m-d');
    $overdue = $d['kind'] === 'invoice' && $d['status'] === 'issued' && $d['due_date'] && $d['due_date'] < date('Y-m-d');
    return [
        'id' => (int) $d['id'], 'kind' => $d['kind'], 'number' => $d['number'], 'status' => $d['status'], 'subject' => $d['subject'], 'subtype' => $d['subtype'],
        'client_id' => (int) $d['client_id'], 'client' => $clients[$d['client_id']] ?? '?', 'total' => (int) $d['total'],
        'issue_date' => $d['issue_date'], 'due_date' => $d['due_date'], 'valid_until' => $d['valid_until'], 'paid_at' => $d['paid_at'],
        'parent_id' => $d['parent_id'] ? (int) $d['parent_id'] : null, 'parent_number' => $d['parent_id'] ? ($numbers[$d['parent_id']] ?? null) : null,
        'expired' => $expired, 'overdue' => $overdue,
    ];
}

/** Chiffre d'affaires encaissé sur une année (factures payées, hors factures annulées par un avoir). */
function bill_revenue(int $year): int
{
    $st = db()->prepare("SELECT COALESCE(SUM(total), 0) FROM bill_docs WHERE kind = 'invoice' AND status = 'paid' AND substr(paid_at, 1, 4) = ?");
    $st->execute([(string) $year]);
    return (int) $st->fetchColumn();
}

/** Document complet pour l'affichage : instantané figé s'il est émis, données courantes sinon. */
function bill_view(int $id): array
{
    $d = bill_doc($id);
    $parent = $d['parent_id'] ? bill_doc((int) $d['parent_id']) : null;
    $base = [
        'id' => (int) $d['id'], 'kind' => $d['kind'], 'number' => $d['number'], 'status' => $d['status'], 'subtype' => $d['subtype'], 'subject' => $d['subject'],
        'delivery' => $d['delivery'], 'notes' => $d['notes'], 'deposit_percent' => (int) $d['deposit_percent'], 'terms_days' => (int) $d['terms_days'],
        'service_date' => $d['service_date'], 'paid_at' => $d['paid_at'], 'paid_method' => $d['paid_method'], 'client_id' => (int) $d['client_id'],
        'parent_id' => $d['parent_id'] ? (int) $d['parent_id'] : null, 'parent_number' => $parent['number'] ?? null,
    ];
    if ($d['snapshot']) {
        $s = json_decode((string) $d['snapshot'], true);
        return $base + ['frozen' => true, 'seller' => $s['seller'], 'client' => $s['client'], 'lines' => $s['lines'], 'total' => $s['total'],
            'issue_date' => $s['issue_date'], 'valid_until' => $s['valid_until'], 'due_date' => $s['due_date']];
    }
    return $base + ['frozen' => false, 'seller' => bill_seller(), 'client' => bill_client((int) $d['client_id']), 'lines' => json_decode((string) $d['lines'], true) ?: [],
        'total' => (int) $d['total'], 'issue_date' => $d['issue_date'], 'valid_until' => null, 'due_date' => null];
}
