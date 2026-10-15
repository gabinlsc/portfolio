# Page 404 commune (errors/404.html du dépôt), pour les sites qui n'ont pas de 404.html dans leur racine :
# jeux (uno, president, vortex), admin.glsc.fr et click.glsc.fr. Installée par deploy2.sh et deploy5.sh.
# Les sites statiques (glsc.fr, cv, share, old, games, status) gardent leur copie de 404.html.
error_page 404 /404.html;
proxy_intercept_errors on;   # jeux : remplace les 404 des conteneurs par cette page
location = /404.html { root /var/www/glsc-errors; internal; }
location ^~ /_glsc/fonts { root /var/www/glsc-errors; try_files $uri =404; expires 30d; }
