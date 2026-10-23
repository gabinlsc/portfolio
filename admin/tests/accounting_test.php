<?php
/** Tests de la compta (sans HTTP) :  php admin/tests/accounting_test.php */
declare(strict_types=1);

$var = sys_get_temp_dir() . '/glsc-acct-test-' . bin2hex(random_bytes(4));
mkdir("$var/app", 0777, true);
putenv("GLSC_ADMIN_VAR=$var");
putenv("GLSC_ADMIN_ETC=$var/etc");
require __DIR__ . '/../lib/bootstrap.php';
require __DIR__ . '/../lib/billing.php';
require __DIR__ . '/../lib/accounting.php';

$ok = 0;
function check(bool $cond, string $what): void { global $ok; if (!$cond) { fwrite(STDERR, "✗ $what\n"); exit(1); } $ok++; echo "✓ $what\n"; }
function fails(callable $fn, int $status, string $what): void
{
    try { $fn(); } catch (HttpError $e) { check($e->status === $status, $what . ' (' . $e->getMessage() . ')'); return; }
    check(false, "$what : aucune erreur levée");
}

// ---- réglages
$s = acct_settings();
check($s['activity'] === 'bnc' && $s['rate'] === 25.6 && $s['ceiling'] === 83600 && $s['vat_base'] === 37500 && $s['vat_major'] === 41250 && $s['frequency'] === 'quarter', 'réglages par défaut : BNC 25,6 %, plafond 83 600 €, franchise 37 500 / 41 250 €, trimestriel');
fails(fn () => acct_save_settings(['activity' => 'inconnue', 'frequency' => 'month']), 422, 'activité inconnue refusée');
fails(fn () => acct_save_settings(['activity' => 'bnc', 'frequency' => 'month', 'rate' => '99']), 422, 'taux hors limites refusé');
$s = acct_save_settings(['activity' => 'bic_services', 'frequency' => 'month', 'rate' => '', 'acre' => '50', 'vl_rate' => '', 'extra_rate' => '', 'ceiling' => '', 'vat_base' => '', 'vat_major' => '', 'start_date' => '2026-10-01']);
check($s['activity'] === 'bic_services' && $s['rate'] === 21.2 && $s['acre'] === 50.0 && $s['frequency'] === 'month', 'activité BIC services : taux 21,2 % par défaut, ACRE 50 %');
check(acct_contribution(100000, $s)['total'] === 10600, 'cotisations : 1 000 € × 21,2 % × (1 − 50 %) = 106 €');
acct_save_settings(['activity' => 'bnc', 'frequency' => 'quarter', 'rate' => '25,6', 'acre' => '0', 'vl_rate' => '2,2', 'extra_rate' => '0', 'ceiling' => '', 'vat_base' => '', 'vat_major' => '', 'start_date' => '']);
check(acct_contribution(100000, acct_settings())['social'] === 25600 && acct_contribution(100000, acct_settings())['vl'] === 2200, 'cotisations BNC 25,6 % + versement libératoire 2,2 %');

// ---- périodes
$q = acct_periods(2026, 'quarter');
check(count($q) === 4 && $q[0]['due'] === '2026-04-30' && $q[1]['due'] === '2026-07-31' && $q[2]['due'] === '2026-10-31' && $q[3]['due'] === '2027-01-31', 'trimestres : échéances 30/04, 31/07, 31/10 et 31/01');
$m = acct_periods(2026, 'month');
check(count($m) === 12 && $m[0]['due'] === '2026-02-28' && $m[11]['due'] === '2027-01-31', 'mois : échéance à la fin du mois suivant');

// ---- données : factures payées (réelles et test), avoir, remboursement
bill_set_test_mode(false);
bill_save_seller(['name' => 'Gabin Lescoat', 'brand' => 'StudioGLSC', 'siret' => '73282932000074', 'address' => '1 rue Test', 'postcode' => '56100', 'city' => 'Lorient', 'email' => 'pro@glsc.fr']);
$now = time();
db()->prepare('INSERT INTO bill_clients(name, siren, created, updated) VALUES(?, ?, ?, ?)')->execute(['Boulangerie Le Fournil', '732829320', $now, $now]);
$client = (int) db()->lastInsertId();
$draft = fn (int $cents, string $subject) => ['kind' => 'invoice', 'client_id' => $client, 'subject' => $subject, 'lines' => [['desc' => $subject, 'qty' => 1, 'unit' => $cents]]];
$pay = function (int $id, string $date, string $day) { bill_issue($id, $day); bill_set_status($id, 'paid', $date, 'virement'); };
$f1 = bill_save_draft($draft(59000, 'Site Express'), '2026-01-10'); $pay($f1, '2026-01-20', '2026-01-10');
$f2 = bill_save_draft($draft(79000, 'Pack Lancement'), '2026-02-10'); $pay($f2, '2026-02-15', '2026-02-10');
$f3 = bill_save_draft($draft(30000, 'Modifications'), '2026-05-04'); $pay($f3, '2026-05-20', '2026-05-04');
$f4 = bill_save_draft($draft(10000, 'Facture annulée avant paiement'), '2026-05-05'); bill_issue($f4, '2026-05-05');
$cr4 = bill_derive_credit($f4, '2026-05-06'); bill_issue($cr4, '2026-05-06');
$f5 = bill_save_draft($draft(20000, 'Facture payée puis remboursée'), '2026-06-01'); $pay($f5, '2026-06-05', '2026-06-01');
$cr5 = bill_derive_credit($f5, '2026-06-20'); bill_issue($cr5, '2026-06-20');
bill_set_test_mode(true);
$ft = bill_save_draft($draft(99900, 'Essai'), '2026-03-01'); bill_issue($ft, '2026-03-01'); bill_set_status($ft, 'paid', '2026-03-02', 'virement');
bill_set_test_mode(false);
$f6 = bill_save_draft($draft(40000, 'Facture à encaisser'), '2026-09-01'); bill_issue($f6, '2026-09-01');

$ledger = acct_ledger(2026);
check(count($ledger) === 5, 'livre des recettes : 4 encaissements + 1 remboursement, ni la facture annulée avant paiement ni le test (' . count($ledger) . ')');
check(array_column($ledger, 'date') === ['2026-01-20', '2026-02-15', '2026-05-20', '2026-06-05', '2026-06-20'], 'livre des recettes : ordre chronologique');
$total = array_sum(array_column($ledger, 'amount'));
check($total === 59000 + 79000 + 30000 + 20000 - 20000, 'total des recettes : 1 680 € (le remboursement est négatif)');
check(acct_ledger(2025) === [], 'aucune recette en 2025');
$months = acct_month_totals($ledger);
check($months[1] === 59000 && $months[2] === 79000 && $months[5] === 30000 && $months[6] === 0, 'totaux par mois (juin : 200 € − 200 € = 0)');

// ---- déclarations
$set = acct_settings();
$rows = acct_period_rows(2026, $ledger, $set, '2026-11-01');
check($rows[0]['revenue'] === 138000 && $rows[1]['revenue'] === 30000 && $rows[2]['revenue'] === 0, 'trimestres : T1 1 380 €, T2 300 € (juin net 0), T3 0');
check($rows[0]['status'] === 'late' && $rows[1]['status'] === 'late' && $rows[2]['status'] === 'late' || $rows[2]['status'] === 'todo', 'trimestres passés non déclarés : en retard (échéances dépassées)');
check($rows[0]['contribution'] === (int) round(138000 * (25.6 + 0) / 100) + (int) round(138000 * 0.022), 'cotisations T1 = sociales + versement libératoire');
fails(fn () => acct_save_declaration(['period' => '2026-Q9']), 422, 'période invalide refusée');
acct_save_declaration(['period' => '2026-Q1', 'declared_at' => '2026-04-15', 'revenue_declared' => 138000, 'paid_at' => '2026-04-16', 'amount_paid' => 40000]);
$rows = acct_period_rows(2026, $ledger, $set, '2026-11-01');
check($rows[0]['status'] === 'paid' && $rows[0]['amount_paid'] === 40000, 'déclaration enregistrée : T1 payé');
acct_save_declaration(['period' => '2026-Q1', 'declared_at' => '2026-04-15', 'revenue_declared' => 138000]);
check(acct_period_rows(2026, $ledger, $set, '2026-11-01')[0]['status'] === 'declared', 'déclarée mais pas payée : « déclarée »');
acct_save_declaration(['period' => '2026-Q1', 'clear' => true]);
check(acct_period_rows(2026, $ledger, $set, '2026-11-01')[0]['status'] === 'late', 'déclaration effacée : de nouveau en retard');
check(acct_period_rows(2026, $ledger, $set, '2026-03-01')[0]['status'] === 'open', 'trimestre en cours : ouvert');

// ---- dépenses
fails(fn () => acct_expense_row(['date' => 'hier', 'label' => 'x', 'amount' => 100]), 422, 'date de dépense invalide refusée');
fails(fn () => acct_expense_row(['date' => '2026-03-01', 'label' => 'x', 'amount' => -5]), 422, 'montant négatif refusé');
fails(fn () => acct_expense_row(['date' => '2026-03-01', 'label' => 'x', 'amount' => 100, 'category' => 'inconnue']), 422, 'catégorie inconnue refusée');
$e = acct_expense_row(['date' => '2026-03-01', 'supplier' => 'IONOS', 'label' => 'VPS', 'amount' => 1200, 'category' => 'hebergement']);
db()->prepare('INSERT INTO bill_expenses(date, supplier, label, category, amount, created, updated) VALUES(?, ?, ?, ?, ?, 1, 1)')->execute([$e['date'], $e['supplier'], $e['label'], $e['category'], $e['amount']]);
check(count(acct_expenses(2026)) === 1 && acct_expenses(2025) === [], 'dépense enregistrée, par année');

// ---- vue d'ensemble
$ov = acct_overview(2026, '2026-11-01');
check($ov['revenue'] === $total && $ov['expenses_total'] === 1200 && $ov['net'] === $total - $ov['contributions'] - 1200, 'vue d’ensemble : CA, dépenses et résultat net estimé');
check($ov['unpaid']['count'] === 1 && $ov['unpaid']['total'] === 40000 && $ov['unpaid']['overdue'] === 1, 'à encaisser : 1 facture de 400 €, en retard');
check($ov['top_clients']['Boulangerie Le Fournil'] === $total, 'meilleur client');
check($ov['thresholds']['ceiling'] === 8360000 && $ov['years'][0] === (int) date('Y'), 'plafond en centimes, années proposées');

// ---- exports
$csv = acct_csv_ledger(2026);
check(str_starts_with($csv, "\u{FEFF}\"N°\";") && str_contains($csv, '"590,00"') && str_contains($csv, "\"Total\";\"" . acct_money($total) . "\""), 'CSV du livre des recettes : BOM, virgule décimale, total');
check(acct_csv_cell('=1+1') === "\"'=1+1\"" && acct_csv_cell('-5,00') === '"-5,00"' && acct_csv_cell('a"b') === '"a""b"', 'CSV : formules neutralisées, guillemets protégés, nombres négatifs conservés');
check(substr_count(acct_csv_invoices(2026), "\r\n") >= 6, 'CSV des factures');
$arch = acct_archive();
check($arch['format'] === 'glsc-compta-1' && count($arch['documents']) >= 6 && is_array($arch['documents'][0]['snapshot']) && count($arch['expenses']) === 1, 'archive : documents avec instantané, dépenses');
check(!in_array('Essai', array_column($arch['documents'], 'subject'), true), 'archive : sans les documents de test');

echo "\nTous les tests passent ($ok).\n";
