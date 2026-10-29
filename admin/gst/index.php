<?php
/**
 * gst.glsc.fr — point d'entrée de l'espace StudioGLSC (installé par deploy5.sh dans /var/www/gst.glsc.fr).
 * Même code que admin.glsc.fr, avec ses propres identifiants (/etc/glsc-gst) et sa propre base (/var/lib/glsc-gst).
 */
declare(strict_types=1);

putenv('GLSC_ADMIN_INSTANCE=gst');
require (getenv('GLSC_ADMIN_LIB') ?: '/opt/glsc-admin/lib') . '/router.php';
handle_request();
