<?php
// admin.glsc.fr — tout le code vit hors du site, dans /opt/glsc-admin/lib (voir admin/README.md).
declare(strict_types=1);
require (getenv('GLSC_ADMIN_LIB') ?: '/opt/glsc-admin/lib') . '/router.php';
handle_request();
