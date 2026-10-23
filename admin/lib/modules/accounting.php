<?php
/**
 * Compta (voir lib/accounting.php) : tableau de bord, livre des recettes, dépenses, déclarations de cotisations, réglages, exports.
 */
declare(strict_types=1);

require_once __DIR__ . '/../billing.php';
require_once __DIR__ . '/../accounting.php';

function acct_year_param(): int
{
    $y = (int) ($_GET['year'] ?? date('Y'));
    return $y >= 2000 && $y <= (int) date('Y') + 1 ? $y : (int) date('Y');
}

return [
    'GET accounting/overview' => fn () => acct_overview(acct_year_param(), date('Y-m-d')),
    'GET accounting/ledger' => function () {
        $e = acct_ledger(acct_year_param());
        return ['year' => acct_year_param(), 'entries' => $e, 'total' => array_sum(array_column($e, 'amount')), 'seller' => bill_seller()];
    },
    'GET accounting/expenses' => fn () => ['year' => acct_year_param(), 'expenses' => acct_expenses(acct_year_param()), 'categories' => ACCT_CATEGORIES],
    'POST accounting/settings' => fn () => ['settings' => acct_save_settings(body())],
    'POST accounting/expense' => function () {
        $b = body();
        $row = acct_expense_row($b);
        $id = int_in($b, 'id', 0, 0) ?? 0;
        $now = time();
        if ($id) {
            $n = db()->prepare('SELECT COUNT(*) FROM bill_expenses WHERE id = ?');
            $n->execute([$id]);
            if (!(int) $n->fetchColumn()) fail(404, 'Dépense introuvable.');
            $set = implode(', ', array_map(fn ($k) => "$k = :$k", array_keys($row)));
            db()->prepare("UPDATE bill_expenses SET $set, updated = :updated WHERE id = :id")->execute($row + ['updated' => $now, 'id' => $id]);
            return ['id' => $id];
        }
        $cols = array_merge(array_keys($row), ['created', 'updated']);
        db()->prepare('INSERT INTO bill_expenses(' . implode(', ', $cols) . ') VALUES(' . implode(', ', array_map(fn ($c) => ':' . $c, $cols)) . ')')->execute($row + ['created' => $now, 'updated' => $now]);
        return ['id' => (int) db()->lastInsertId()];
    },
    'POST accounting/expense/delete' => function () {
        db()->prepare('DELETE FROM bill_expenses WHERE id = ?')->execute([int_in(body(), 'id', 0, 1) ?: fail(422, 'Dépense invalide.')]);
        return ['ok' => true];
    },
    'POST accounting/declaration' => function () {
        acct_save_declaration(body());
        return ['ok' => true];
    },
    // Téléchargements (toujours en pièce jointe)
    'GET accounting/export' => function () {
        $type = (string) ($_GET['type'] ?? '');
        $year = acct_year_param();
        [$body, $mime, $name] = match ($type) {
            'ledger' => [acct_csv_ledger($year), 'text/csv; charset=utf-8', "livre-des-recettes-$year.csv"],
            'expenses' => [acct_csv_expenses($year), 'text/csv; charset=utf-8', "depenses-$year.csv"],
            'invoices' => [acct_csv_invoices($year), 'text/csv; charset=utf-8', "factures-$year.csv"],
            'archive' => [json_encode(acct_archive(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), 'application/json; charset=utf-8', 'archive-compta-' . date('Y-m-d') . '.json'],
            default => fail(422, 'Export inconnu.'),
        };
        header('Content-Type: ' . $mime);
        header('Content-Disposition: attachment; filename="' . $name . '"');
        header('Content-Length: ' . strlen($body));
        header('Cache-Control: no-store');
        echo $body;
        exit;
    },
];
