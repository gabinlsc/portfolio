<?php
/**
 * Comptabilité de la micro-entreprise : livre des recettes (généré depuis les factures encaissées), dépenses (suivi facultatif), cotisations à déclarer,
 * plafonds (chiffre d'affaires, franchise de TVA), exports (CSV, archive). Fonctions sans HTTP : testables avec admin/tests/accounting_test.php.
 *
 * Les taux et seuils par défaut sont ceux publiés pour 2026 ; ils sont tous modifiables dans les réglages de la compta (à vérifier sur autoentrepreneur.urssaf.fr).
 * Les documents de test n'entrent jamais dans la comptabilité.
 */
declare(strict_types=1);

const ACCT_ACTIVITIES = [
    'bnc' => ['label' => 'Prestations libérales (BNC)', 'rate' => 25.6, 'ceiling' => 83600, 'vat_base' => 37500, 'vat_major' => 41250],
    'bic_services' => ['label' => 'Prestations commerciales ou artisanales (BIC)', 'rate' => 21.2, 'ceiling' => 83600, 'vat_base' => 37500, 'vat_major' => 41250],
    'bic_vente' => ['label' => 'Vente de marchandises (BIC)', 'rate' => 12.3, 'ceiling' => 203100, 'vat_base' => 85000, 'vat_major' => 93500],
];
const ACCT_CATEGORIES = [
    'hebergement' => 'Hébergement, domaine, serveur', 'logiciels' => 'Logiciels et abonnements', 'materiel' => 'Matériel', 'assurance' => 'Assurance',
    'banque' => 'Banque', 'formation' => 'Formation', 'deplacements' => 'Déplacements', 'cotisations' => 'Cotisations, CFE, impôts', 'marketing' => 'Communication et publicité', 'autre' => 'Autre',
];

function acct_get(string $key, string $default = ''): string { return (string) setting('acct_' . $key, $default); }

/** Réglages résolus (taux et seuils par défaut selon l'activité). */
function acct_settings(): array
{
    $activity = acct_get('activity', 'bnc');
    if (!isset(ACCT_ACTIVITIES[$activity])) $activity = 'bnc';
    $def = ACCT_ACTIVITIES[$activity];
    $num = fn (string $k, float $d) => ($v = acct_get($k)) !== '' && is_numeric($v) ? (float) $v : $d;
    return [
        'activity' => $activity, 'frequency' => acct_get('frequency', 'quarter') === 'month' ? 'month' : 'quarter',
        'rate' => $num('rate', $def['rate']), 'extra_rate' => $num('extra_rate', 0.0), 'acre' => min(100.0, max(0.0, $num('acre', 0.0))),
        'vl_rate' => $num('vl_rate', 0.0), 'ceiling' => (int) $num('ceiling', (float) $def['ceiling']),
        'vat_base' => (int) $num('vat_base', (float) $def['vat_base']), 'vat_major' => (int) $num('vat_major', (float) $def['vat_major']),
        'start_date' => acct_get('start_date'),
        'defaults' => ['rate' => $def['rate'], 'ceiling' => $def['ceiling'], 'vat_base' => $def['vat_base'], 'vat_major' => $def['vat_major']],
    ];
}

function acct_save_settings(array $b): array
{
    $activity = str_in($b, 'activity', 20, true);
    if (!isset(ACCT_ACTIVITIES[$activity])) fail(422, 'Activité inconnue.');
    $freq = str_in($b, 'frequency', 10, true);
    if (!in_array($freq, ['month', 'quarter'], true)) fail(422, 'Fréquence inconnue.');
    $pct = function (string $k, float $max) use ($b): string {
        $v = str_replace(',', '.', str_in($b, $k, 10));
        if ($v === '') return '';
        if (!is_numeric($v) || (float) $v < 0 || (float) $v > $max) fail(422, "Champ « $k » : nombre entre 0 et $max attendu.");
        return (string) round((float) $v, 2);
    };
    $euro = function (string $k) use ($b): string {
        $v = str_replace([' ', ','], ['', '.'], str_in($b, $k, 12));
        if ($v === '') return '';
        if (!is_numeric($v) || (float) $v < 0 || (float) $v > 100_000_000) fail(422, "Champ « $k » : montant invalide.");
        return (string) (int) round((float) $v);
    };
    $start = str_in($b, 'start_date', 10);
    if ($start !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $start)) fail(422, 'Date de création invalide.');
    foreach (['activity' => $activity, 'frequency' => $freq, 'rate' => $pct('rate', 60), 'extra_rate' => $pct('extra_rate', 20), 'acre' => $pct('acre', 100), 'vl_rate' => $pct('vl_rate', 10),
        'ceiling' => $euro('ceiling'), 'vat_base' => $euro('vat_base'), 'vat_major' => $euro('vat_major'), 'start_date' => $start] as $k => $v) set_setting('acct_' . $k, $v === '' ? null : $v);
    return acct_settings();
}

// ---------------------------------------------------------------- livre des recettes

/**
 * Encaissements de l'année, du plus ancien au plus récent : chaque facture réelle payée (à la date de réception), et le remboursement d'un avoir émis sur une facture
 * déjà payée (montant négatif, à la date de l'avoir). Une facture annulée avant paiement n'apparaît pas.
 */
function acct_ledger(int $year): array
{
    $pdo = db();
    $name = function (array $d): string {
        $s = $d['snapshot'] ? json_decode((string) $d['snapshot'], true) : null;
        return (string) (($s['client']['name'] ?? null) ?: ($d['client_name'] ?? '?'));
    };
    $out = [];
    $st = $pdo->prepare("SELECT d.*, c.name AS client_name FROM bill_docs d JOIN bill_clients c ON c.id = d.client_id
        WHERE d.kind = 'invoice' AND d.test = 0 AND d.paid_at IS NOT NULL AND substr(d.paid_at, 1, 4) = ? ORDER BY d.paid_at, d.id");
    $st->execute([(string) $year]);
    foreach ($st->fetchAll() as $d) {
        $out[] = ['date' => $d['paid_at'], 'number' => $d['number'], 'client' => $name($d), 'subject' => $d['subject'] ?: ($d['subtype'] === 'deposit' ? 'Acompte' : ''), 'method' => $d['paid_method'], 'amount' => (int) $d['total'], 'doc_id' => (int) $d['id'], 'refund' => false];
    }
    $cr = $pdo->prepare("SELECT d.*, c.name AS client_name, p.paid_at AS parent_paid, p.number AS parent_number, p.paid_method AS parent_method
        FROM bill_docs d JOIN bill_clients c ON c.id = d.client_id JOIN bill_docs p ON p.id = d.parent_id
        WHERE d.kind = 'credit' AND d.test = 0 AND d.status = 'issued' AND p.paid_at IS NOT NULL AND substr(d.issue_date, 1, 4) = ? ORDER BY d.issue_date, d.id");
    $cr->execute([(string) $year]);
    foreach ($cr->fetchAll() as $d) {
        $out[] = ['date' => $d['issue_date'], 'number' => $d['number'], 'client' => $name($d), 'subject' => 'Remboursement (avoir sur ' . $d['parent_number'] . ')', 'method' => $d['parent_method'], 'amount' => (int) $d['total'], 'doc_id' => (int) $d['id'], 'refund' => true];
    }
    usort($out, fn ($a, $b) => [$a['date'], $a['number']] <=> [$b['date'], $b['number']]);
    return $out;
}

/** Totaux par mois (clés 1 à 12) en centimes. */
function acct_month_totals(array $ledger): array
{
    $m = array_fill(1, 12, 0);
    foreach ($ledger as $e) $m[(int) substr($e['date'], 5, 2)] += $e['amount'];
    return $m;
}

// ---------------------------------------------------------------- périodes de déclaration

function acct_last_day(int $year, int $month): string { return (new DateTimeImmutable(sprintf('%04d-%02d-01', $year, $month)))->format('Y-m-t'); }

/** Périodes de l'année : clé, libellé, bornes et date limite de déclaration (fin du mois suivant, ou fin du mois suivant le trimestre). */
function acct_periods(int $year, string $freq): array
{
    $out = [];
    if ($freq === 'month') {
        for ($m = 1; $m <= 12; $m++) {
            $dueY = $m === 12 ? $year + 1 : $year; $dueM = $m === 12 ? 1 : $m + 1;
            $out[] = ['key' => sprintf('%04d-%02d', $year, $m), 'label' => ucfirst(acct_month_name($m)) . " $year", 'from' => sprintf('%04d-%02d-01', $year, $m), 'to' => acct_last_day($year, $m), 'due' => acct_last_day($dueY, $dueM)];
        }
        return $out;
    }
    foreach ([1 => [1, 3], 2 => [4, 6], 3 => [7, 9], 4 => [10, 12]] as $q => [$a, $b]) {
        $dueY = $q === 4 ? $year + 1 : $year; $dueM = $q === 4 ? 1 : $b + 1;
        $out[] = ['key' => sprintf('%04d-Q%d', $year, $q), 'label' => "T$q $year", 'from' => sprintf('%04d-%02d-01', $year, $a), 'to' => acct_last_day($year, $b), 'due' => acct_last_day($dueY, $dueM)];
    }
    return $out;
}

/** Nom du mois en français (sans dépendre de l'extension intl). */
function acct_month_name(int $m): string
{
    return ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'][$m];
}

/** Cotisations estimées pour un chiffre d'affaires encaissé (centimes) : [sociales, versement libératoire, total]. */
function acct_contribution(int $revenue, array $set): array
{
    $social = (int) round($revenue * (($set['rate'] + $set['extra_rate']) / 100) * (1 - $set['acre'] / 100));
    $vl = (int) round($revenue * $set['vl_rate'] / 100);
    return ['social' => $social, 'vl' => $vl, 'total' => $social + $vl];
}

function acct_declarations(): array
{
    $out = [];
    foreach (db()->query('SELECT * FROM bill_declarations')->fetchAll() as $d) $out[$d['period']] = $d;
    return $out;
}

/** Enregistre (ou efface) ce que tu as déclaré et payé pour une période. */
function acct_save_declaration(array $b): void
{
    $period = str_in($b, 'period', 8, true);
    if (!preg_match('/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/', $period)) fail(422, 'Période invalide.');
    if (bool_in($b, 'clear')) { db()->prepare('DELETE FROM bill_declarations WHERE period = ?')->execute([$period]); return; }
    $date = function (string $k) use ($b): ?string {
        $v = str_in($b, $k, 10);
        if ($v === '') return null;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) fail(422, "Date « $k » invalide.");
        return $v;
    };
    $cents = function (string $k) use ($b): ?int {
        $v = $b[$k] ?? null;
        if ($v === null || $v === '') return null;
        if (!is_numeric($v) || (int) $v != $v || (int) $v < 0 || (int) $v > 10_000_000_00) fail(422, "Montant « $k » invalide.");
        return (int) $v;
    };
    db()->prepare('INSERT INTO bill_declarations(period, declared_at, revenue_declared, paid_at, amount_paid, note, updated) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(period) DO UPDATE SET declared_at = excluded.declared_at, revenue_declared = excluded.revenue_declared, paid_at = excluded.paid_at,
        amount_paid = excluded.amount_paid, note = excluded.note, updated = excluded.updated')
        ->execute([$period, $date('declared_at'), $cents('revenue_declared'), $date('paid_at'), $cents('amount_paid'), str_in($b, 'note', 300), time()]);
}

/** Périodes de l'année avec chiffre d'affaires, cotisations estimées et état (à déclarer, déclarée, payée, en retard). */
function acct_period_rows(int $year, array $ledger, array $set, string $today): array
{
    $decl = acct_declarations();
    $rows = [];
    foreach (acct_periods($year, $set['frequency']) as $p) {
        $rev = 0;
        foreach ($ledger as $e) if ($e['date'] >= $p['from'] && $e['date'] <= $p['to']) $rev += $e['amount'];
        $c = acct_contribution($rev, $set);
        $d = $decl[$p['key']] ?? null;
        $over = $p['to'] < $today; // période terminée
        $status = $d && $d['declared_at'] ? ($d['paid_at'] ? 'paid' : 'declared') : ($over && $p['due'] < $today ? 'late' : ($over ? 'todo' : 'open'));
        $rows[] = $p + ['revenue' => $rev, 'social' => $c['social'], 'vl' => $c['vl'], 'contribution' => $c['total'], 'status' => $status,
            'declared_at' => $d['declared_at'] ?? null, 'revenue_declared' => isset($d['revenue_declared']) ? (int) $d['revenue_declared'] : null,
            'paid_at' => $d['paid_at'] ?? null, 'amount_paid' => isset($d['amount_paid']) ? (int) $d['amount_paid'] : null, 'note' => $d['note'] ?? ''];
    }
    return $rows;
}

// ---------------------------------------------------------------- dépenses

function acct_expense_row(array $b): array
{
    $date = str_in($b, 'date', 10, true);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) fail(422, 'Date invalide.');
    $amount = $b['amount'] ?? null;
    if (!is_numeric($amount) || (int) $amount != $amount || (int) $amount <= 0 || (int) $amount > 10_000_000_00) fail(422, 'Montant invalide (en centimes, positif).');
    $cat = str_in($b, 'category', 20, false, 'autre');
    if (!isset(ACCT_CATEGORIES[$cat])) fail(422, 'Catégorie inconnue.');
    return ['date' => $date, 'supplier' => str_in($b, 'supplier', 80), 'label' => str_in($b, 'label', 160, true), 'category' => $cat, 'amount' => (int) $amount,
        'method' => str_in($b, 'method', 30), 'ref' => str_in($b, 'ref', 60), 'note' => str_in($b, 'note', 300)];
}

function acct_expenses(int $year): array
{
    $st = db()->prepare('SELECT * FROM bill_expenses WHERE substr(date, 1, 4) = ? ORDER BY date DESC, id DESC');
    $st->execute([(string) $year]);
    return $st->fetchAll();
}

// ---------------------------------------------------------------- vue d'ensemble

function acct_overview(int $year, string $today): array
{
    $set = acct_settings();
    $ledger = acct_ledger($year);
    $months = acct_month_totals($ledger);
    $revenue = array_sum($months);
    $periods = acct_period_rows($year, $ledger, $set, $today);
    $expenses = acct_expenses($year);
    $spent = array_sum(array_map(fn ($e) => (int) $e['amount'], $expenses));
    $contrib = array_sum(array_map(fn ($p) => $p['contribution'], $periods));
    $byCat = [];
    foreach ($expenses as $e) $byCat[$e['category']] = ($byCat[$e['category']] ?? 0) + (int) $e['amount'];
    $clients = [];
    foreach ($ledger as $e) $clients[$e['client']] = ($clients[$e['client']] ?? 0) + $e['amount'];
    arsort($clients);
    $pdo = db();
    $unpaid = $pdo->query("SELECT COUNT(*) n, COALESCE(SUM(total), 0) s FROM bill_docs WHERE kind = 'invoice' AND test = 0 AND status = 'issued'")->fetch();
    $overdue = $pdo->prepare("SELECT COUNT(*) FROM bill_docs WHERE kind = 'invoice' AND test = 0 AND status = 'issued' AND due_date < ?");
    $overdue->execute([$today]);
    $todo = array_values(array_filter($periods, fn ($p) => in_array($p['status'], ['todo', 'late'], true)));
    $next = null;
    foreach ($periods as $p) if (in_array($p['status'], ['open', 'todo', 'late'], true) && ($next === null || $p['due'] < $next['due'])) $next = $p;
    return [
        'year' => $year, 'settings' => $set, 'revenue' => $revenue, 'months' => array_values($months), 'count' => count($ledger),
        'contributions' => $contrib, 'expenses_total' => $spent, 'net' => $revenue - $contrib - $spent,
        'expenses_by_category' => $byCat, 'top_clients' => array_slice($clients, 0, 5, true),
        'unpaid' => ['count' => (int) $unpaid['n'], 'total' => (int) $unpaid['s'], 'overdue' => (int) $overdue->fetchColumn()],
        'periods' => $periods, 'next' => $next, 'to_declare' => count($todo),
        'thresholds' => ['ceiling' => $set['ceiling'] * 100, 'vat_base' => $set['vat_base'] * 100, 'vat_major' => $set['vat_major'] * 100],
        'years' => acct_years(),
    ];
}

/** Années proposées : de la première année avec un document (ou dépense) à l'année en cours. */
function acct_years(): array
{
    $min = (int) db()->query("SELECT MIN(y) FROM (SELECT MIN(substr(COALESCE(paid_at, issue_date), 1, 4)) y FROM bill_docs WHERE test = 0 UNION ALL SELECT MIN(substr(date, 1, 4)) FROM bill_expenses)")->fetchColumn();
    $now = (int) date('Y');
    $min = $min >= 2000 && $min <= $now ? $min : $now;
    return range($now, $min);
}

// ---------------------------------------------------------------- exports

/** Une cellule CSV : neutralise les formules (=, +, -, @) et protège les séparateurs. */
function acct_csv_cell(mixed $v): string
{
    $s = (string) $v;
    if ($s !== '' && in_array($s[0], ['=', '+', '-', '@', "\t", "\r"], true) && !is_numeric(str_replace(',', '.', $s))) $s = "'" . $s;
    return '"' . str_replace('"', '""', $s) . '"';
}

/** CSV pour Excel en français : séparateur « ; », virgule décimale, BOM UTF-8. */
function acct_csv(array $header, array $rows): string
{
    $line = fn (array $r) => implode(';', array_map('acct_csv_cell', $r));
    return "\u{FEFF}" . $line($header) . "\r\n" . implode('', array_map(fn ($r) => $line($r) . "\r\n", $rows));
}

function acct_money(int $cents): string { return number_format($cents / 100, 2, ',', ''); }

function acct_csv_ledger(int $year): string
{
    $rows = [];
    $total = 0;
    foreach (acct_ledger($year) as $i => $e) {
        $total += $e['amount'];
        $rows[] = [$i + 1, $e['date'], $e['number'], $e['client'], $e['subject'], $e['method'], acct_money($e['amount'])];
    }
    $rows[] = ['', '', '', '', '', 'Total', acct_money($total)];
    return acct_csv(['N°', 'Date d’encaissement', 'Référence', 'Client', 'Nature', 'Mode de règlement', 'Montant (€)'], $rows);
}

function acct_csv_expenses(int $year): string
{
    $rows = [];
    $total = 0;
    foreach (array_reverse(acct_expenses($year)) as $e) {
        $total += (int) $e['amount'];
        $rows[] = [$e['date'], $e['supplier'], $e['label'], ACCT_CATEGORIES[$e['category']] ?? $e['category'], $e['method'], $e['ref'], acct_money((int) $e['amount'])];
    }
    $rows[] = ['', '', '', '', '', 'Total', acct_money($total)];
    return acct_csv(['Date', 'Fournisseur', 'Libellé', 'Catégorie', 'Mode de règlement', 'N° de pièce', 'Montant TTC (€)'], $rows);
}

function acct_csv_invoices(int $year): string
{
    $st = db()->prepare("SELECT d.*, c.name AS client_name FROM bill_docs d JOIN bill_clients c ON c.id = d.client_id WHERE d.test = 0 AND d.kind IN ('invoice', 'credit') AND d.number IS NOT NULL AND substr(d.issue_date, 1, 4) = ? ORDER BY d.issue_date, d.seq");
    $st->execute([(string) $year]);
    $rows = [];
    foreach ($st->fetchAll() as $d) {
        $s = $d['snapshot'] ? json_decode((string) $d['snapshot'], true) : [];
        $rows[] = [$d['number'], $d['kind'] === 'credit' ? 'Avoir' : 'Facture', $d['issue_date'], $s['client']['name'] ?? $d['client_name'], $s['client']['siren'] ?? '', $d['subject'], acct_money((int) $d['total']), $d['due_date'] ?? '', $d['status'], $d['paid_at'] ?? ''];
    }
    return acct_csv(['Numéro', 'Type', 'Date d’émission', 'Client', 'SIREN du client', 'Objet', 'Total (€)', 'Échéance', 'Statut', 'Date de paiement'], $rows);
}

/** Archive complète (conservation 10 ans) : documents émis avec leur instantané figé, clients, dépenses, déclarations. */
function acct_archive(): array
{
    $docs = [];
    foreach (db()->query("SELECT * FROM bill_docs WHERE test = 0 AND number IS NOT NULL ORDER BY kind, year, seq")->fetchAll() as $d) {
        $d['snapshot'] = $d['snapshot'] ? json_decode((string) $d['snapshot'], true) : null;
        $d['lines'] = json_decode((string) $d['lines'], true);
        $docs[] = $d;
    }
    return ['generated' => date('c'), 'format' => 'glsc-compta-1', 'documents' => $docs,
        'clients' => db()->query('SELECT * FROM bill_clients WHERE test = 0')->fetchAll(),
        'expenses' => db()->query('SELECT * FROM bill_expenses ORDER BY date')->fetchAll(), 'declarations' => array_values(acct_declarations())];
}
