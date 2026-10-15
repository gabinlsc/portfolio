<?php
/** Bloc-notes, liens rapides et liens courts (click.glsc.fr). */
declare(strict_types=1);

const RESERVED_SLUGS = ['admin', 'api', 'assets', 'f', 'login', 'logout', 'robots.txt', 'favicon.ico', '_glsc', '404.html'];

function shortlink_rows(): array
{
    $rows = db()->query('SELECT id, slug, target, note, active, clicks, created, last_click FROM shortlinks ORDER BY created DESC')->fetchAll();
    // clics par jour sur 14 jours, pour la mini-courbe
    $since = strtotime('today') - 13 * 86400;
    $q = db()->prepare("SELECT link_id, CAST((at - ?) / 86400 AS INTEGER) d, COUNT(*) n FROM shortlink_clicks WHERE at >= ? GROUP BY link_id, d");
    $q->execute([$since, $since]);
    $spark = [];
    foreach ($q->fetchAll() as $r) $spark[$r['link_id']][(int) $r['d']] = (int) $r['n'];
    foreach ($rows as &$r) {
        $r['spark'] = array_map(fn ($d) => $spark[$r['id']][$d] ?? 0, range(0, 13));
    }
    return $rows;
}

return [
    // ---------------------------------------------------------------- notes
    'GET notes/list' => fn () => ['notes' => db()->query('SELECT * FROM notes ORDER BY pinned DESC, updated DESC')->fetchAll()],
    'POST notes/save' => function () {
        $b = body();
        $f = [str_in($b, 'title', 120), str_in($b, 'body', 20000), enum_in($b, 'color', COLORS, 'banana'), bool_in($b, 'pinned') ? 1 : 0];
        if ($f[0] === '' && $f[1] === '') fail(422, 'Note vide.');
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE notes SET title = ?, body = ?, color = ?, pinned = ?, updated = ? WHERE id = ?')->execute([...$f, time(), $id]);
        } else {
            db()->prepare('INSERT INTO notes(title, body, color, pinned, created, updated) VALUES(?, ?, ?, ?, ?, ?)')->execute([...$f, time(), time()]);
        }
        return ['notes' => db()->query('SELECT * FROM notes ORDER BY pinned DESC, updated DESC')->fetchAll()];
    },
    'POST notes/delete' => function () {
        db()->prepare('DELETE FROM notes WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return ['notes' => db()->query('SELECT * FROM notes ORDER BY pinned DESC, updated DESC')->fetchAll()];
    },

    // ---------------------------------------------------------------- liens rapides
    'GET links/list' => fn () => ['links' => db()->query('SELECT * FROM quicklinks ORDER BY position, id')->fetchAll()],
    'POST links/save' => function () {
        $b = body();
        $f = [str_in($b, 'label', 40, true), url_in($b, 'url'), enum_in($b, 'color', COLORS, 'sky')];
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE quicklinks SET label = ?, url = ?, color = ? WHERE id = ?')->execute([...$f, $id]);
        } else {
            db()->prepare('INSERT INTO quicklinks(label, url, color, position) VALUES(?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM quicklinks))')->execute($f);
        }
        return ['links' => db()->query('SELECT * FROM quicklinks ORDER BY position, id')->fetchAll()];
    },
    'POST links/delete' => function () {
        db()->prepare('DELETE FROM quicklinks WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return ['links' => db()->query('SELECT * FROM quicklinks ORDER BY position, id')->fetchAll()];
    },

    // ---------------------------------------------------------------- liens courts
    'GET short/list' => fn () => ['links' => shortlink_rows(), 'base' => 'https://click.glsc.fr/'],
    'POST short/save' => function () {
        $b = body();
        $target = url_in($b, 'target');
        $note = str_in($b, 'note', 120);
        $active = bool_in($b, 'active', true) ? 1 : 0;
        $slug = strtolower(str_in($b, 'slug', 40));
        if ($slug === '') {
            do {
                $slug = substr(strtr(base64_encode(random_bytes(6)), '+/=', 'xyz'), 0, 6);
                $slug = strtolower($slug);
                $q = db()->prepare('SELECT 1 FROM shortlinks WHERE slug = ?');
                $q->execute([$slug]);
            } while ($q->fetchColumn());
        }
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,39}$/', $slug) || in_array($slug, RESERVED_SLUGS, true)) {
            fail(422, 'Nom court invalide : lettres, chiffres, - et _ uniquement.');
        }
        if (parse_url($target, PHP_URL_HOST) === 'click.glsc.fr') fail(422, 'Un lien court ne peut pas pointer vers click.glsc.fr.');
        try {
            if ($id = int_in($b, 'id')) {
                db()->prepare('UPDATE shortlinks SET slug = ?, target = ?, note = ?, active = ? WHERE id = ?')->execute([$slug, $target, $note, $active, $id]);
            } else {
                db()->prepare('INSERT INTO shortlinks(slug, target, note, active, created) VALUES(?, ?, ?, ?, ?)')->execute([$slug, $target, $note, $active, time()]);
            }
        } catch (PDOException $e) {
            if (str_contains($e->getMessage(), 'UNIQUE')) fail(422, "Le nom « $slug » est déjà pris.");
            throw $e;
        }
        return ['links' => shortlink_rows()];
    },
    'POST short/delete' => function () {
        db()->prepare('DELETE FROM shortlinks WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return ['links' => shortlink_rows()];
    },
    'GET short/stats' => function () {
        $id = (int) int_in($_GET, 'id', 0);
        $since = time() - 90 * 86400;
        $q = db()->prepare("SELECT CASE WHEN referer = '' THEN 'direct' ELSE referer END ref, COUNT(*) n FROM shortlink_clicks
                            WHERE link_id = ? AND at >= ? GROUP BY ref ORDER BY n DESC LIMIT 10");
        $q->execute([$id, $since]);
        $refs = $q->fetchAll();
        $q = db()->prepare('SELECT device, COUNT(*) n FROM shortlink_clicks WHERE link_id = ? AND at >= ? GROUP BY device ORDER BY n DESC');
        $q->execute([$id, $since]);
        return ['referers' => $refs, 'devices' => $q->fetchAll()];
    },
];
