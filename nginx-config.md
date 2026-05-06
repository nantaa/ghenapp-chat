# Nginx Configuration — GhenApp (`/etc/nginx/sites-available/default`)

> **Domain**: `ghen-app.my.id`  
> **VPS IP**: `103.191.92.143`  
> **Backend**: Go server on `127.0.0.1:8080`  
> **Frontend**: Static files at `/opt/ghenapp/repo/ghenapp-web/dist`

Replace the contents of `/etc/nginx/sites-available/default` with this complete config.
After Certbot runs, it will add the TLS blocks automatically.

---

## Complete Config

```nginx
# ── HTTP → HTTPS redirect ─────────────────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name ghen-app.my.id www.ghen-app.my.id;

    # Certbot ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ── HTTPS main server ─────────────────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ghen-app.my.id www.ghen-app.my.id;

    # TLS — Certbot will fill these in automatically
    # ssl_certificate     /etc/letsencrypt/live/ghen-app.my.id/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/ghen-app.my.id/privkey.pem;
    # include             /etc/letsencrypt/options-ssl-nginx.conf;
    # ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # ── Security headers ──────────────────────────────────────────────────────
    add_header X-Frame-Options         "SAMEORIGIN"   always;
    add_header X-Content-Type-Options  "nosniff"      always;
    add_header Referrer-Policy         "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy      "camera=(), microphone=(), geolocation=()" always;
    # Required for Web Push (VAPID) and WebCrypto
    add_header Cross-Origin-Opener-Policy   "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # ── Frontend (React SPA) ──────────────────────────────────────────────────
    root  /opt/ghenapp/repo/ghenapp-web/dist;
    index index.html;

    # SPA fallback — all unknown paths serve index.html (React router handles them)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache hashed JS/CSS/image assets for 30 days (Vite adds content hash to filename)
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Service Worker must NEVER be cached — browser must always re-fetch it
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma        "no-cache";
        expires 0;
    }

    # ── Backend REST API ──────────────────────────────────────────────────────
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;

        # Increase body size for file uploads (matches backend MAX_UPLOAD_BYTES)
        client_max_body_size 4M;
    }

    # ── WebSocket — IMCP real-time channel ───────────────────────────────────
    location /ws {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;  # Keep WS alive for 1 hour
        proxy_send_timeout 3600s;
    }

    # ── Uploaded user files ───────────────────────────────────────────────────
    location /api/v1/files/ {
        proxy_pass       http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_buffering  off;
        client_max_body_size 4M;
    }

    # ── Health check (no auth, for monitoring) ───────────────────────────────
    location = /health {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

---

## Setup Steps

### 1. Write the config

```bash
sudo nano /etc/nginx/sites-available/default
# Paste the config above (without the TLS lines — Certbot adds them)
```

### 2. Test and reload

```bash
sudo nginx -t          # Must print: syntax is ok / test is successful
sudo systemctl reload nginx
```

### 3. Obtain TLS certificate

```bash
sudo certbot --nginx \
  -d ghen-app.my.id \
  -d www.ghen-app.my.id \
  --email admin@ghen-app.my.id \
  --agree-tos \
  --non-interactive

# Verify auto-renewal works
sudo certbot renew --dry-run
```

### 4. Verify the full stack

```bash
# Health check through Nginx
curl https://ghen-app.my.id/health

# Noise pubkey endpoint
curl https://ghen-app.my.id/api/v1/noise/pubkey
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `502 Bad Gateway` on `/api/` | Backend not running | `sudo systemctl status ghenapp` |
| WebSocket disconnects immediately | Missing `Upgrade` header | Check the `/ws` location block |
| Push notifications broken | Missing `Cross-Origin-*` headers | Ensure security headers are present |
| `/sw.js` is cached | Missing no-cache header on `/sw.js` | Check the `location = /sw.js` block |
| Large file upload fails | `client_max_body_size` too small | Increase to match `MAX_UPLOAD_BYTES` |
