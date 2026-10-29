<?php
/**
 * Accueil de gst.glsc.fr (espace StudioGLSC) : ce qui demande une action, en un coup d'œil.
 * Ne fait que résumer les modules Devis & factures, Compta et StudioGLSC ; n'écrit rien.
 */
declare(strict_types=1);

require_once __DIR__ . '/../billing.php';
require_once __DIR__ . '/../accounting.php';

return [
    'GET gst/home' => function () {
        $today = date('Y-m-d');
        $year = (int) date('Y');
        $acct = acct_overview($year, $today);

        $pdo = db();
        $drafts = (int) $pdo->query("SELECT COUNT(*) FROM bill_docs WHERE status = 'draft' AND test = 0")->fetchColumn();
        $quotes = $pdo->query("SELECT COUNT(*) n, COALESCE(SUM(total), 0) s FROM bill_docs WHERE kind = 'quote' AND status = 'issued' AND test = 0")->fetch();
        $seller = bill_seller();

        // service studio : s'il est absent, l'accueil s'affiche quand même
        $studio = ['down' => null, 'new_requests' => 0, 'open_requests' => 0, 'unread' => 0, 'requests' => []];
        try {
            $svc = studio_call('GET', '/admin/overview');
            $reqs = array_values((array) ($svc['requests'] ?? []));
            $studio['new_requests'] = count(array_filter($reqs, fn ($r) => ($r['status'] ?? '') === 'new'));
            $studio['open_requests'] = count(array_filter($reqs, fn ($r) => in_array($r['status'] ?? '', ['new', 'contacted', 'quote'], true)));
            $studio['unread'] = array_sum(array_map(fn ($p) => (int) ($p['unread'] ?? 0), (array) ($svc['projects'] ?? [])));
            $studio['active_projects'] = count(array_filter((array) ($svc['projects'] ?? []), fn ($p) => ($p['status'] ?? '') === 'active'));
            $studio['requests'] = array_map(fn ($r) => [
                'name' => (string) ($r['name'] ?? ''), 'status' => (string) ($r['status'] ?? ''), 'service' => (string) ($r['service'] ?? ''), 'at' => (int) ($r['at'] ?? 0),
            ], array_slice(array_filter($reqs, fn ($r) => ($r['status'] ?? '') === 'new'), 0, 5));
        } catch (HttpError $e) {
            $studio['down'] = $e->getMessage();
        }

        return [
            'year' => $year,
            'seller_missing' => bill_seller_missing($seller),
            'revenue' => $acct['revenue'], 'net' => $acct['net'], 'contributions' => $acct['contributions'],
            'ceiling' => $acct['thresholds']['ceiling'], 'vat_base' => $acct['thresholds']['vat_base'],
            'months' => $acct['months'],
            'unpaid' => $acct['unpaid'], 'next_declaration' => $acct['next'], 'to_declare' => $acct['to_declare'],
            'drafts' => $drafts, 'quotes_open' => ['count' => (int) $quotes['n'], 'total' => (int) $quotes['s']],
            'test_mode' => bill_test_mode(),
            'studio' => $studio,
        ];
    },
];
