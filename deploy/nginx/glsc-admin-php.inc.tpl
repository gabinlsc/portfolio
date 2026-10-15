# Commun à admin.glsc.fr et click.glsc.fr : toute requête est traitée par index.php (installé par deploy5.sh).
include fastcgi_params;
fastcgi_param SCRIPT_FILENAME $document_root/index.php;
fastcgi_param SCRIPT_NAME /index.php;
fastcgi_param GLSC_ADMIN_XACCEL 1;
fastcgi_pass unix:__PHP_SOCK__;
# les en-têtes de sécurité sont envoyés par PHP ; nginx n'ajoute que celui-ci (et n'hérite donc pas des autres)
add_header X-Robots-Tag "noindex, nofollow" always;
