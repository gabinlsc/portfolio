<?php
/** Kanban : tableaux, colonnes et cartes (glisser-déposer côté interface). */
declare(strict_types=1);

function kanban_board(int $id): array
{
    $q = db()->prepare('SELECT id, name FROM boards WHERE id = ?');
    $q->execute([$id]);
    $board = $q->fetch() ?: fail(404, 'Tableau introuvable.');
    $q = db()->prepare('SELECT id, name, color FROM columns WHERE board_id = ? ORDER BY position, id');
    $q->execute([$id]);
    $cols = $q->fetchAll();
    $cards = db()->prepare('SELECT id, title, body, label, due, updated FROM cards WHERE column_id = ? ORDER BY position, id');
    foreach ($cols as &$c) {
        $cards->execute([$c['id']]);
        $c['cards'] = $cards->fetchAll();
    }
    $board['columns'] = $cols;
    return $board;
}

/** Réordonne une liste d'identifiants appartenant tous à la même table/parent. */
function reorder(string $table, string $parentCol, int $parent, array $ids): void
{
    $ids = array_values(array_map('intval', array_filter($ids, 'is_numeric')));
    $upd = db()->prepare("UPDATE $table SET position = ? WHERE id = ? AND $parentCol = ?");
    foreach ($ids as $pos => $id) $upd->execute([$pos, $id, $parent]);
}

function column_board(int $columnId): int
{
    $q = db()->prepare('SELECT board_id FROM columns WHERE id = ?');
    $q->execute([$columnId]);
    return (int) ($q->fetchColumn() ?: fail(404, 'Colonne introuvable.'));
}

return [
    'GET kanban/boards' => function () {
        $boards = db()->query('SELECT b.id, b.name, (SELECT COUNT(*) FROM cards c JOIN columns k ON k.id = c.column_id WHERE k.board_id = b.id) AS cards
                               FROM boards b ORDER BY b.position, b.id')->fetchAll();
        return ['boards' => $boards];
    },
    'GET kanban/board' => fn () => ['board' => kanban_board((int) int_in($_GET, 'id', 0))],

    'POST kanban/board-save' => function () {
        $b = body();
        $name = str_in($b, 'name', 60, true);
        $id = int_in($b, 'id');
        if ($id) {
            db()->prepare('UPDATE boards SET name = ? WHERE id = ?')->execute([$name, $id]);
            return ['board' => kanban_board($id)];
        }
        $pdo = db();
        $pdo->beginTransaction();
        $pdo->prepare('INSERT INTO boards(name, position, created) VALUES(?, (SELECT COALESCE(MAX(position) + 1, 0) FROM boards), ?)')->execute([$name, time()]);
        $id = (int) $pdo->lastInsertId();
        $col = $pdo->prepare('INSERT INTO columns(board_id, name, color, position) VALUES(?, ?, ?, ?)');
        foreach ([['À faire', 'banana'], ['En cours', 'sky'], ['Fait', 'mint']] as $i => [$n, $c]) $col->execute([$id, $n, $c, $i]);
        $pdo->commit();
        return ['board' => kanban_board($id)];
    },
    'POST kanban/board-delete' => function () {
        if ((int) db()->query('SELECT COUNT(*) FROM boards')->fetchColumn() <= 1) fail(422, 'Garde au moins un tableau.');
        db()->prepare('DELETE FROM boards WHERE id = ?')->execute([int_in(body(), 'id', 0)]);
        return ['ok' => true];
    },

    'POST kanban/column-save' => function () {
        $b = body();
        $name = str_in($b, 'name', 40, true);
        $color = enum_in($b, 'color', COLORS, 'paper');
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE columns SET name = ?, color = ? WHERE id = ?')->execute([$name, $color, $id]);
            return ['board' => kanban_board(column_board($id))];
        }
        $board = (int) int_in($b, 'board_id', 0);
        kanban_board($board);
        db()->prepare('INSERT INTO columns(board_id, name, color, position) VALUES(?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM columns WHERE board_id = ?))')
            ->execute([$board, $name, $color, $board]);
        return ['board' => kanban_board($board)];
    },
    'POST kanban/column-delete' => function () {
        $id = (int) int_in(body(), 'id', 0);
        $board = column_board($id);
        db()->prepare('DELETE FROM columns WHERE id = ?')->execute([$id]);
        return ['board' => kanban_board($board)];
    },
    'POST kanban/column-order' => function () {
        $b = body();
        $board = (int) int_in($b, 'board_id', 0);
        reorder('columns', 'board_id', $board, (array) ($b['ids'] ?? []));
        return ['board' => kanban_board($board)];
    },

    'POST kanban/card-save' => function () {
        $b = body();
        $fields = [str_in($b, 'title', 200, true), str_in($b, 'body', 5000), str_in($b, 'label', 30), date_in($b, 'due')];
        if ($id = int_in($b, 'id')) {
            db()->prepare('UPDATE cards SET title = ?, body = ?, label = ?, due = ?, updated = ? WHERE id = ?')->execute([...$fields, time(), $id]);
            $q = db()->prepare('SELECT column_id FROM cards WHERE id = ?');
            $q->execute([$id]);
            return ['board' => kanban_board(column_board((int) $q->fetchColumn()))];
        }
        $col = (int) int_in($b, 'column_id', 0);
        $board = column_board($col);
        db()->prepare('INSERT INTO cards(column_id, title, body, label, due, position, created, updated)
                       VALUES(?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM cards WHERE column_id = ?), ?, ?)')
            ->execute([$col, ...$fields, $col, time(), time()]);
        return ['board' => kanban_board($board)];
    },
    'POST kanban/card-delete' => function () {
        $id = (int) int_in(body(), 'id', 0);
        $q = db()->prepare('SELECT column_id FROM cards WHERE id = ?');
        $q->execute([$id]);
        $col = (int) ($q->fetchColumn() ?: fail(404, 'Carte introuvable.'));
        db()->prepare('DELETE FROM cards WHERE id = ?')->execute([$id]);
        return ['board' => kanban_board(column_board($col))];
    },
    /** Déplace une carte dans une colonne (éventuellement une autre) et fixe l'ordre de cette colonne. */
    'POST kanban/card-move' => function () {
        $b = body();
        $id = (int) int_in($b, 'id', 0);
        $col = (int) int_in($b, 'column_id', 0);
        $board = column_board($col);
        $q = db()->prepare('SELECT k.board_id FROM cards c JOIN columns k ON k.id = c.column_id WHERE c.id = ?');
        $q->execute([$id]);
        if ((int) $q->fetchColumn() !== $board) fail(422, 'Carte et colonne de tableaux différents.');
        db()->prepare('UPDATE cards SET column_id = ?, updated = ? WHERE id = ?')->execute([$col, time(), $id]);
        reorder('cards', 'column_id', $col, (array) ($b['ids'] ?? []));
        return ['board' => kanban_board($board)];
    },
];
