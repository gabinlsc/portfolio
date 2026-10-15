# click.glsc.fr — liens courts créés dans admin.glsc.fr, installé par deploy5.sh.
server {
    listen 443 ssl;
    server_name click.glsc.fr;
    include /etc/nginx/glsc-404.inc;
    root /var/www/click.glsc.fr;

    location ^~ /assets/ { try_files $uri =404; expires 7d; }
    location ^~ /_glsc/ { try_files $uri =404; expires 30d; }
    location = /robots.txt { try_files $uri =404; }
    location ~ /\. { return 404; }
    location / {
        limit_req zone=glsc_games burst=60 nodelay;
        fastcgi_intercept_errors on;   # lien inconnu : la 404 commune
        include /etc/nginx/glsc-admin-php.inc;
    }

    ssl_certificate /etc/letsencrypt/live/click.glsc.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/click.glsc.fr/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name click.glsc.fr;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 301 https://$host$request_uri; }
}
