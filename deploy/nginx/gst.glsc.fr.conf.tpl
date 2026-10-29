# gst.glsc.fr — espace StudioGLSC (devis, factures, compta, demandes et projets clients), installé par deploy5.sh.
# Même code que admin.glsc.fr (/opt/glsc-admin/lib) mais identifiants et données à part. Tout passe par /var/www/gst.glsc.fr/index.php.
server {
    listen 443 ssl;
    server_name gst.glsc.fr;
    include /etc/nginx/glsc-404.inc;
    root /var/www/gst.glsc.fr;
    client_max_body_size 2m;

    # fichiers statiques de l'interface (pas de données dedans)
    location ^~ /assets/ { try_files $uri =404; expires 7d; }
    location ^~ /_glsc/ { try_files $uri =404; expires 30d; }

    location = /login {
        limit_req zone=glsc_admin_login burst=5 nodelay;
        limit_req_status 429;
        include /etc/nginx/glsc-admin-php.inc;
    }
    location ~ /\. { return 404; }
    # l'API garde ses erreurs JSON ; les pages, elles, affichent la 404 commune
    location ^~ /api/ { include /etc/nginx/glsc-admin-php.inc; }
    location / { fastcgi_intercept_errors on; include /etc/nginx/glsc-admin-php.inc; }

    ssl_certificate /etc/letsencrypt/live/gst.glsc.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gst.glsc.fr/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name gst.glsc.fr;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 301 https://$host$request_uri; }
}
