<?php
// click.glsc.fr — redirige un lien court (créé dans admin.glsc.fr) et compte le clic.
declare(strict_types=1);
require (getenv('GLSC_ADMIN_LIB') ?: '/opt/glsc-admin/lib') . '/click.php';
