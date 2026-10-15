# admin.glsc.fr — espace privé (PHP + SQLite), installé par deploy5.sh.
# Tout passe par /var/www/admin.glsc.fr/index.php ; le code vit dans /opt/glsc-admin/lib.
server {
    listen 443 ssl;
    server_name admin.glsc.fr;
    include /etc/nginx/glsc-404.inc;
    root /var/www/admin.glsc.fr;
    client_max_body_size 2m;

    # fichiers statiques de l'interface (pas de données dedans)
    location ^~ /assets/ { try_files $uri =404; expires 7d; }
    location ^~ /_glsc/ { try_files $uri =404; expires 30d; }

    # téléchargement des fichiers partagés, servi par nginx une fois le lien vérifié par PHP
    location ^~ /_files/ {
        internal;
        alias /var/lib/glsc-admin/app/files/;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "sandbox; default-src 'none'" always;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }

    location = /login {
        limit_req zone=glsc_admin_login burst=5 nodelay;
        limit_req_status 429;
        include /etc/nginx/glsc-admin-php.inc;
    }
    # webhook GitHub (déploiement automatique) : public, la signature HMAC est vérifiée par PHP
    location = /hooks/github {
        client_max_body_size 5m;
        limit_req zone=glsc_admin_login burst=10 nodelay;
        limit_req_status 429;
        include /etc/nginx/glsc-admin-php.inc;
    }
    location = /api/files/upload {
        client_max_body_size 210m;
        client_body_timeout 300s;
        fastcgi_read_timeout 300s;
        include /etc/nginx/glsc-admin-php.inc;
        fastcgi_param PHP_VALUE "upload_max_filesize=200M
post_max_size=210M
max_execution_time=300";
    }
    location ~ /\. { return 404; }
    # l'API garde ses erreurs JSON ; les pages, elles, affichent la 404 commune
    location ^~ /api/ { include /etc/nginx/glsc-admin-php.inc; }
    location / { fastcgi_intercept_errors on; include /etc/nginx/glsc-admin-php.inc; }

    ssl_certificate /etc/letsencrypt/live/admin.glsc.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.glsc.fr/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name admin.glsc.fr;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 301 https://$host$request_uri; }
}
