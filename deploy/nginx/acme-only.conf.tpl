# __DOMAIN__ — version temporaire (HTTP) le temps d'obtenir le certificat. Installée par deploy4.sh.
server {
    listen 80;
    server_name __DOMAIN__;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 503; }
}
