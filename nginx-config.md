```nginx
server {
    listen 80;
    server_name ghen-app.my.id www.ghen-app.my.id;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ghen-app.my.id www.ghen-app.my.id;

    ssl_certificate /etc/letsencrypt/live/ghen-app.my.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ghen-app.my.id/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers (required for WebCrypto + Web Push + libsodium WASM)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    # 'wasm-unsafe-eval' required for libsodium-wrappers-sumo (WASM crypto)
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://ghen-app.my.id; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; worker-src 'self';" always;

    # Frontend (React SPA)
    root /var/www/ghenapp;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    # Cache hashed assets (Vite adds content hash to filename)
    location ~* \.(js|css|png|jpg|svg|ico|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Resource-Policy "cross-origin";
    }

    # Service Worker must never be cached
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        expires 0;
    }

    # Backend REST API
    location /api {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        client_max_body_size 4M;
    }

    # WebSocket (IMCP)
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Health check
    location = /health {
        proxy_pass http://127.0.0.1:8080;
    }
}
```
