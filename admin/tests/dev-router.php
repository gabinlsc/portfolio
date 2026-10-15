<?php
// Routeur pour « php -S » (tests locaux uniquement) : fichiers statiques de public/, le reste vers index.php.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = $_SERVER['DOCUMENT_ROOT'];
if ($path !== '/' && is_file($root . $path) && !str_ends_with($path, '.php')) return false;
require $root . '/index.php';
