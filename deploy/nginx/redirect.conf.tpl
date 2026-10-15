# __DOMAIN__ — ancienne adresse, redirigée vers https://__TARGET__ (même chemin), installé par deploy4.sh.
server {
    listen 443 ssl;
    server_name __DOMAIN__;
    location / { return 301 https://__TARGET__$request_uri; }

    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name __DOMAIN__;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 301 https://__TARGET__$request_uri; }
}
