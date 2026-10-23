<?php
/**
 * Devis et factures (voir lib/billing.php) : clients, brouillons, émission numérotée, factures d'acompte et de solde, avoirs, réglages du vendeur.
 * Les documents émis sont figés ; l'impression en PDF se fait depuis l'interface (aperçu + « Imprimer »).
 */
declare(strict_types=1);

require_once __DIR__ . '/../billing.php';

function bill_today(): string { return date('Y-m-d'); }

return [
    'GET billing/overview' => function () {
        $pdo = db();
        $clientsRaw = $pdo->query('SELECT * FROM bill_clients ORDER BY name COLLATE NOCASE')->fetchAll();
        $names = [];
        foreach ($clientsRaw as $c) $names[(int) $c['id']] = $c['name'];
        $docs = $pdo->query('SELECT * FROM bill_docs ORDER BY COALESCE(issue_date, \'9999\') DESC, id DESC')->fetchAll();
        $numbers = [];
        foreach ($docs as $d) $numbers[(int) $d['id']] = $d['number'];
        $seller = bill_seller();
        $year = (int) date('Y');
        $open = fn (string $kind, array $st) => array_values(array_filter($docs, fn ($d) => $d['kind'] === $kind && in_array($d['status'], $st, true)));
        return [
            'seller' => $seller, 'missing' => bill_seller_missing($seller), 'clients' => $clientsRaw, 'test_mode' => bill_test_mode(),
            'test_count' => count(array_filter($docs, fn ($d) => (int) $d['test'] === 1)),
            'docs' => array_map(fn ($d) => bill_summary($d, $names, $numbers), $docs),
            'stats' => [
                'year' => $year, 'revenue' => bill_revenue($year), 'limit' => (int) $seller['ca_limit'] * 100,
                'unpaid' => array_sum(array_map(fn ($d) => (int) $d['total'], $open('invoice', ['issued']))),
                'quotes_open' => array_sum(array_map(fn ($d) => (int) $d['total'], $open('quote', ['issued']))),
            ],
        ];
    },
    'GET billing/doc' => function () {
        $id = (int) ($_GET['id'] ?? 0);
        if ($id < 1) fail(422, 'Document invalide.');
        return bill_view($id);
    },
    'POST billing/settings' => fn () => ['seller' => bill_save_seller(body())],
    'POST billing/client' => function () {
        $b = body();
        $row = bill_client_row($b);
        $now = time();
        $id = int_in($b, 'id', 0, 0) ?? 0;
        if ($id) {
            bill_client($id);
            $set = implode(', ', array_map(fn ($k) => "$k = :$k", array_keys($row)));
            db()->prepare("UPDATE bill_clients SET $set, updated = :updated WHERE id = :id")->execute($row + ['updated' => $now, 'id' => $id]);
            return ['id' => $id];
        }
        $cols = array_merge(array_keys($row), ['test', 'created', 'updated']);
        db()->prepare('INSERT INTO bill_clients(' . implode(', ', $cols) . ') VALUES(' . implode(', ', array_map(fn ($c) => ':' . $c, $cols)) . ')')
            ->execute($row + ['test' => bill_test_mode() ? 1 : 0, 'created' => $now, 'updated' => $now]);
        return ['id' => (int) db()->lastInsertId()];
    },
    'POST billing/client/delete' => function () {
        $id = int_in(body(), 'id', 0, 1) ?: fail(422, 'Client invalide.');
        bill_client($id);
        $n = db()->prepare('SELECT COUNT(*) FROM bill_docs WHERE client_id = ?');
        $n->execute([$id]);
        if ((int) $n->fetchColumn() > 0) fail(409, 'Ce client a des devis ou des factures : ils se conservent 10 ans, le client aussi.');
        db()->prepare('DELETE FROM bill_clients WHERE id = ?')->execute([$id]);
        return ['ok' => true];
    },
    'POST billing/doc/save' => fn () => ['id' => bill_save_draft(body(), bill_today())],
    'POST billing/doc/issue' => function () {
        $id = int_in(body(), 'id', 0, 1) ?: fail(422, 'Document invalide.');
        $r = bill_issue($id, bill_today());
        return $r;
    },
    'POST billing/doc/status' => function () {
        $b = body();
        $id = int_in($b, 'id', 0, 1) ?: fail(422, 'Document invalide.');
        bill_set_status($id, str_in($b, 'status', 12, true), str_in($b, 'paid_at', 10, false, bill_today()), str_in($b, 'method', 30));
        return ['ok' => true];
    },
    'POST billing/doc/derive' => function () {
        $b = body();
        $id = int_in($b, 'id', 0, 1) ?: fail(422, 'Document invalide.');
        $type = str_in($b, 'type', 10, true);
        return ['id' => $type === 'credit' ? bill_derive_credit($id, bill_today()) : bill_derive_invoice($id, $type, bill_today())];
    },
    'POST billing/doc/duplicate' => fn () => ['id' => bill_duplicate(int_in(body(), 'id', 0, 1) ?: fail(422, 'Document invalide.'), bill_today())],
    'POST billing/doc/delete-test' => function () {
        $b = body();
        $n = bill_delete_test_doc(int_in($b, 'id', 0, 1) ?: fail(422, 'Document invalide.'), str_in($b, 'confirm', 80, true));
        return ['deleted' => $n];
    },
    'POST billing/tests/purge' => function () {
        [$docs, $clients] = bill_purge_tests(str_in(body(), 'confirm', 80, true));
        return ['documents' => $docs, 'clients' => $clients];
    },
    'POST billing/mode' => function () {
        $b = body();
        $test = bool_in($b, 'test');
        if (!$test && str_in($b, 'confirm', 40, true) !== 'PRODUCTION') fail(422, 'Pour passer en production, tape exactement « PRODUCTION ».');
        bill_set_test_mode($test);
        return ['test_mode' => bill_test_mode()];
    },
    'POST billing/doc/delete' => function () {
        bill_delete_draft(int_in(body(), 'id', 0, 1) ?: fail(422, 'Document invalide.'));
        return ['ok' => true];
    },
];
