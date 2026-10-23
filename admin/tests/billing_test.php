<?php
/** Tests des devis et factures (sans HTTP) :  php admin/tests/billing_test.php */
declare(strict_types=1);

$var = sys_get_temp_dir() . '/glsc-billing-test-' . bin2hex(random_bytes(4));
mkdir("$var/app", 0777, true);
putenv("GLSC_ADMIN_VAR=$var");
putenv("GLSC_ADMIN_ETC=$var/etc");
require __DIR__ . '/../lib/bootstrap.php';
require __DIR__ . '/../lib/billing.php';

$ok = 0;
function check(bool $cond, string $what): void
{
    global $ok;
    if (!$cond) { fwrite(STDERR, "✗ $what\n"); exit(1); }
    $ok++;
    echo "✓ $what\n";
}
function fails(callable $fn, int $status, string $what): void
{
    try { $fn(); } catch (HttpError $e) { check($e->status === $status, $what . ' (' . $e->getMessage() . ')'); return; }
    check(false, "$what : aucune erreur levée");
}

// ---- montants et contrôles
check(bill_line_total(['qty' => 1, 'unit' => 59000]) === 59000, 'ligne : 1 × 590 € = 590 €');
check(bill_line_total(['qty' => 2.5, 'unit' => 4500]) === 11250, 'ligne : 2,5 h × 45 € = 112,50 €');
check(bill_line_total(['qty' => 1.5, 'unit' => 333]) === 500, 'ligne : arrondi au centime (499,5 → 500)');
check(bill_line_total(['qty' => 1, 'unit' => -5000]) === -5000, 'ligne : montant négatif (remise, acompte déduit)');
check(bill_total([['qty' => 1, 'unit' => 59000], ['qty' => 1, 'unit' => 15000]]) === 74000, 'total de deux lignes');
check(str_replace(["\u{202F}", "\u{00A0}"], ' ', bill_eur(123456)) === '1 234,56 €', 'format 1 234,56 €');
check(str_replace(["\u{202F}", "\u{00A0}"], ' ', bill_eur(59000)) === '590 €', 'format 590 € (sans centimes)');
check(bill_siren_ok('732829320') && !bill_siren_ok('732829321') && !bill_siren_ok('12345'), 'SIREN : clé de Luhn');
check(bill_siret_ok('73282932000074') && !bill_siret_ok('73282932000075'), 'SIRET : clé de Luhn');
fails(fn () => bill_clean_lines([['desc' => 'x', 'qty' => 0, 'unit' => 100]]), 422, 'quantité nulle refusée');
fails(fn () => bill_clean_lines([['desc' => '', 'qty' => 1, 'unit' => 100]]), 422, 'description vide refusée');
check(bill_clean_lines([['desc' => '', 'qty' => 1, 'unit' => 0]]) === [], 'ligne vide ignorée');

// ---- vendeur
bill_set_test_mode(false); // le déroulé principal se fait en production ; le mode test est vérifié en fin de fichier
fails(fn () => bill_save_seller(['siret' => '73282932000075']), 422, 'SIRET invalide refusé');
check(bill_seller_missing(bill_seller()) !== [], 'vendeur incomplet : il manque le SIRET et l’adresse');
bill_save_seller(['name' => 'Gabin Lescoat', 'brand' => 'StudioGLSC', 'siret' => '732 829 320 00074', 'address' => '1 rue Test', 'postcode' => '56100', 'city' => 'Lorient', 'email' => 'pro@glsc.fr']);
check(bill_seller_missing(bill_seller()) === [] && bill_seller()['siren'] === '732829320', 'vendeur complet, SIREN déduit du SIRET');

// ---- client
$now = time();
db()->prepare('INSERT INTO bill_clients(name, siren, created, updated) VALUES(?, ?, ?, ?)')->execute(['Boulangerie Le Fournil', '732829320', $now, $now]);
$client = (int) db()->lastInsertId();
$draft = ['kind' => 'quote', 'client_id' => $client, 'subject' => 'Site vitrine', 'deposit_percent' => 50, 'terms_days' => 30,
    'lines' => [['desc' => 'Express — site d’une page', 'qty' => 1, 'unit' => 59000], ['desc' => 'Fiche Google', 'qty' => 1, 'unit' => 15000]]];

// ---- devis : brouillon → émission
$today = '2026-11-03';
$q = bill_save_draft($draft, $today);
check(bill_doc($q)['total'] === 74000 && bill_doc($q)['status'] === 'draft' && bill_doc($q)['number'] === null, 'devis brouillon sans numéro, total 740 €');
$q2 = bill_save_draft(array_merge($draft, ['id' => $q, 'subject' => 'Site vitrine v2']), $today);
check($q2 === $q && bill_doc($q)['subject'] === 'Site vitrine v2', 'brouillon modifiable');
$r = bill_issue($q, $today);
check($r['number'] === 'D-2026-001', 'premier devis : D-2026-001');
check(bill_doc($q)['valid_until'] === '2026-12-03', 'validité du devis : 30 jours');
fails(fn () => bill_save_draft($draft + ['id' => $q], $today), 409, 'devis émis : plus modifiable');
fails(fn () => bill_delete_draft($q), 409, 'devis émis : non supprimable');
fails(fn () => bill_issue($q, $today), 409, 'devis déjà émis');
$view = bill_view($q);
check($view['frozen'] && $view['seller']['siret'] === '73282932000074' && $view['client']['name'] === 'Boulangerie Le Fournil', 'instantané figé (vendeur et client)');
db()->prepare("UPDATE bill_clients SET name = 'Autre nom' WHERE id = ?")->execute([$client]);
check(bill_view($q)['client']['name'] === 'Boulangerie Le Fournil', 'le client modifié ne change pas le document émis');
db()->prepare("UPDATE bill_clients SET name = 'Boulangerie Le Fournil' WHERE id = ?")->execute([$client]);
$q3 = bill_save_draft($draft, $today);
check(bill_issue($q3, $today)['number'] === 'D-2026-002', 'numéros consécutifs : D-2026-002');
check(bill_issue(bill_save_draft($draft, '2027-01-04'), '2027-01-04')['number'] === 'D-2027-001', 'la série repart à 001 chaque année');

// ---- statuts du devis
bill_set_status($q, 'accepted', '', '');
check(bill_doc($q)['status'] === 'accepted', 'devis accepté');
fails(fn () => bill_set_status($q, 'paid', '2026-11-04', ''), 409, 'un devis ne peut pas être « payé »');

// ---- facture d'acompte puis solde
$dep = bill_derive_invoice($q, 'deposit', $today);
check(bill_doc($dep)['total'] === 37000, 'acompte de 50 % = 370 €');
fails(fn () => bill_derive_invoice($q, 'balance', $today), 409, 'solde impossible avant l’émission de l’acompte');
check(bill_issue($dep, $today)['number'] === 'F-2026-001', 'première facture : F-2026-001');
check(bill_doc($dep)['due_date'] === $today, 'facture d’acompte : due à réception');
fails(fn () => bill_derive_invoice($q, 'deposit', $today), 409, 'un seul acompte par devis');
$bal = bill_derive_invoice($q, 'balance', '2026-11-20');
check(bill_doc($bal)['total'] === 37000, 'solde = 740 € − 370 € = 370 €');
fails(fn () => bill_issue($bal, '2026-11-02'), 422, 'facture antidatée refusée');
check(bill_issue($bal, '2026-11-20')['number'] === 'F-2026-002' && bill_doc($bal)['due_date'] === '2026-12-20', 'facture de solde F-2026-002, échéance à 30 jours');
bill_set_status($dep, 'paid', '2026-11-05', 'virement');
check(bill_doc($dep)['status'] === 'paid' && bill_revenue(2026) === 37000, 'acompte payé : chiffre d’affaires encaissé 370 €');
bill_set_status($bal, 'paid', '2026-11-25', 'virement');
check(bill_revenue(2026) === 74000, 'solde payé : chiffre d’affaires 740 €');
fails(fn () => bill_derive_invoice($q, 'full', $today), 409, 'facture complète refusée quand il y a déjà des factures');

// ---- avoir
$cr = bill_derive_credit($bal, '2026-12-01');
check(bill_doc($cr)['total'] === -37000, 'avoir : montant inversé');
check(bill_issue($cr, '2026-12-01')['number'] === 'A-2026-001' && bill_doc($bal)['status'] === 'credited', 'avoir A-2026-001, facture annulée');
check(bill_revenue(2026) === 37000, 'la facture annulée sort du chiffre d’affaires');
fails(fn () => bill_derive_credit($bal, '2026-12-02'), 409, 'pas deux avoirs pour la même facture');

// ---- facture complète directe
$q4 = bill_save_draft($draft, '2026-12-05'); bill_issue($q4, '2026-12-05');
$full = bill_derive_invoice($q4, 'full', '2026-12-06');
check(bill_doc($full)['total'] === 74000, 'facture complète = total du devis');

// ---- suppression d'un brouillon, client protégé
$tmp = bill_save_draft($draft, $today); bill_delete_draft($tmp);
check(!db()->query('SELECT 1 FROM bill_docs WHERE id = ' . $tmp)->fetch(), 'brouillon supprimable');
try { db()->prepare('DELETE FROM bill_clients WHERE id = ?')->execute([$client]); check(false, 'client avec documents : suppression bloquée'); }
catch (PDOException $e) { check(true, 'client avec documents : suppression bloquée par la base'); }


// ---- mode test : numérotation à part, émission sans SIRET, exclu du chiffre d'affaires, suppression avec confirmation
$realCount = (int) db()->query('SELECT COUNT(*) FROM bill_docs WHERE test = 0')->fetchColumn();
$realRevenue = bill_revenue(2026);
bill_set_test_mode(true);
check(bill_test_mode(), 'mode test activé');
db()->prepare("DELETE FROM settings WHERE key = 'billing_siret'")->execute(); // vendeur sans SIRET : seuls les tests peuvent s'émettre
$tClient = (function () { $n = time(); db()->prepare('INSERT INTO bill_clients(name, test, created, updated) VALUES(?, 1, ?, ?)')->execute(['Client de test', $n, $n]); return (int) db()->lastInsertId(); })();
$tdraft = ['kind' => 'quote', 'client_id' => $tClient, 'subject' => 'Essai', 'lines' => [['desc' => 'Ligne de test', 'qty' => 1, 'unit' => 10000]]];
$tq = bill_save_draft($tdraft, '2026-12-10');
check((int) bill_doc($tq)['test'] === 1, 'document créé en mode test : marqué test');
check(bill_issue($tq, '2026-12-10')['number'] === 'TEST-D-2026-001', 'émission sans SIRET en mode test : TEST-D-2026-001 (série à part)');
bill_set_test_mode(false);
$real = bill_save_draft(array_merge($tdraft, ['client_id' => $client]), '2026-12-10');
fails(fn () => bill_issue($real, '2026-12-10'), 422, 'document réel : SIRET obligatoire');
check((int) bill_doc($real)['test'] === 0, 'document créé hors mode test : réel');
bill_save_seller(['name' => 'Gabin Lescoat', 'brand' => 'StudioGLSC', 'siret' => '732 829 320 00074', 'address' => '1 rue Test', 'postcode' => '56100', 'city' => 'Lorient', 'email' => 'pro@glsc.fr']);
check(bill_issue($real, '2026-12-10')['number'] === 'D-2026-004', 'la série réelle continue (D-2026-004) malgré les tests');
$tinv = bill_derive_invoice($tq, 'deposit', '2026-12-11');
check((int) bill_doc($tinv)['test'] === 1, 'la facture d’un devis de test est un test');
bill_issue($tinv, '2026-12-11');
check(bill_doc($tinv)['number'] === 'TEST-F-2026-001', 'facture de test : TEST-F-2026-001');
bill_set_status($tinv, 'paid', '2026-12-12', 'virement');
check(bill_revenue(2026) === $realRevenue, 'les tests ne comptent pas dans le chiffre d’affaires');
fails(fn () => bill_delete_test_doc($real, 'D-2026-004'), 409, 'document réel : suppression refusée');
fails(fn () => bill_delete_test_doc($tq, 'mauvais'), 422, 'suppression sans la bonne confirmation refusée');
check(bill_delete_test_doc($tq, 'TEST-D-2026-001') === 2, 'suppression du devis de test : emporte aussi sa facture (2 documents)');
check(!db()->query('SELECT 1 FROM bill_docs WHERE id = ' . $tinv)->fetch(), 'la facture de test a disparu');
check((int) db()->query('SELECT COUNT(*) FROM bill_docs WHERE test = 0')->fetchColumn() === $realCount + 1, 'les documents réels sont intacts');
bill_set_test_mode(true);
$a = bill_save_draft($tdraft, '2026-12-13'); bill_issue($a, '2026-12-13'); $b2 = bill_derive_invoice($a, 'full', '2026-12-13'); bill_issue($b2, '2026-12-13'); bill_derive_credit($b2, '2026-12-14');
bill_save_draft($tdraft, '2026-12-14');
fails(fn () => bill_purge_tests('oui'), 422, 'purge sans la phrase exacte refusée');
[$nd, $nc] = bill_purge_tests(BILL_PURGE_PHRASE);
check($nd === 4 && $nc === 1, "purge : 4 documents de test et 1 client de test supprimés ($nd, $nc)");
check((int) db()->query('SELECT COUNT(*) FROM bill_docs WHERE test = 1')->fetchColumn() === 0, 'plus aucun document de test');
check((int) db()->query('SELECT COUNT(*) FROM bill_docs WHERE test = 0')->fetchColumn() === $realCount + 1, 'documents réels toujours intacts après la purge');
check(bill_issue(bill_save_draft(array_merge($tdraft, ['client_id' => $client]), '2026-12-15'), '2026-12-15')['number'] === 'TEST-D-2026-001', 'après la purge, la série de test repart à 001');

echo "\nTous les tests passent ($ok).\n";
