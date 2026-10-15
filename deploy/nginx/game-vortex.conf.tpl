# __DOMAIN__ — Vortex : client statique servi par nginx, serveur de jeu WebSocket sur 127.0.0.1:__PORT__.
server {
    listen 443 ssl;
    server_name __DOMAIN__;
    include /etc/nginx/glsc-404.inc;

    root /var/www/__DOMAIN__;
    index index.html;

    location = /play {
        limit_req zone=glsc_games burst=20 nodelay;
        proxy_pass http://127.0.0.1:__PORT__/play;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $glsc_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    location ^~ /assets/ { expires 7d; try_files $uri =404; }
    # un fichier absent (wp-login.php, .env, image…) donne la 404 commune ; le reste retombe sur le jeu
    location ~* "\.[a-z0-9]{1,5}$" { try_files $uri =404; }
    location / { try_files $uri $uri/ /index.html; }

    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name __DOMAIN__;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }
    location / { return 301 https://$host$request_uri; }
}
