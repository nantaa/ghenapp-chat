# GhenApp — Setup Guide

> **Stack**: Go 1.21+ · PostgreSQL 16 · Redis 7 · React 18 + Vite + TypeScript  
> **Architecture**: REST API + WebSocket (IMCP) · Noise_XX transport · X3DH + Double Ratchet E2E encryption · VAPID Web Push

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone & Directory Layout](#2-clone--directory-layout)
3. [PostgreSQL Setup](#3-postgresql-setup)
4. [Redis Setup](#4-redis-setup)
5. [Backend Environment (`.env`)](#5-backend-environment-env)
6. [Run Database Migrations](#6-run-database-migrations)
7. [Run the Backend](#7-run-the-backend)
8. [Frontend Environment](#8-frontend-environment)
9. [Run the Frontend (Dev)](#9-run-the-frontend-dev)
10. [First-Run Smoke Test](#10-first-run-smoke-test)
11. [Production Build](#11-production-build)
12. [VPS Deployment (Ubuntu 24.04)](#12-vps-deployment-ubuntu-2404)
13. [Nginx + TLS Configuration](#13-nginx--tls-configuration)
14. [systemd Service](#14-systemd-service)
15. [Environment Variable Reference](#15-environment-variable-reference)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites

Install the following tools before proceeding.

### 1.1 Go (≥ 1.21)

```bash
# Linux / macOS — via official installer
# https://go.dev/dl/
wget https://go.dev/dl/go1.23.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.23.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version  # should print go1.23.x
```

```powershell
# Windows — download and run the installer from https://go.dev/dl/
# Then verify:
go version
```

### 1.2 PostgreSQL 16

```bash
# Ubuntu 24.04
sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql
```

```powershell
# Windows — download from https://www.postgresql.org/download/windows/
# Or use the MSI installer bundled with pgAdmin
```

### 1.3 Redis 7

```bash
# Ubuntu
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping  # should return PONG
```

```powershell
# Windows — use WSL2 or Memurai (https://www.memurai.com/)
# Or run via Docker:
docker run -d -p 6379:6379 redis:7-alpine
```

### 1.4 Node.js (≥ 20 LTS)

```bash
# Linux — via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
node -v  # v20.x.x
```

```powershell
# Windows — download from https://nodejs.org/
node -v
npm -v
```

### 1.5 golang-migrate CLI

```bash
# Linux
curl -L https://github.com/golang-migrate/migrate/releases/download/v4.17.1/migrate.linux-amd64.tar.gz | tar xvz
sudo mv migrate /usr/local/bin/
migrate -version
```

```powershell
# Windows — download from https://github.com/golang-migrate/migrate/releases
# Add to PATH and verify:
migrate -version
```

---

## 2. Clone & Directory Layout

```bash
git clone <your-repo-url> "GhenApp - Chat"
cd "GhenApp - Chat"
```

Expected structure:

```
GhenApp - Chat/
├── ghenapp/              ← Go backend
│   ├── cmd/server/main.go
│   ├── config/
│   ├── internal/
│   │   ├── auth/
│   │   ├── crypto/
│   │   ├── db/
│   │   ├── group/
│   │   ├── message/
│   │   ├── push/
│   │   ├── ratelimit/
│   │   ├── snowflake/
│   │   ├── upload/
│   │   ├── user/
│   │   └── ws/
│   ├── migrations/
│   ├── go.mod
│   └── .env              ← create this (see §5)
│
└── ghenapp-web/          ← React frontend
    ├── public/sw.js
    ├── src/
    ├── .env.local         ← create this (see §8)
    └── package.json
```

---

## 3. PostgreSQL Setup

### 3.1 Create database and user

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE ghenapp;
CREATE USER ghen WITH ENCRYPTED PASSWORD 'your_strong_password';
GRANT ALL PRIVILEGES ON DATABASE ghenapp TO ghen;
\q
```

### 3.2 Verify connection

```bash
psql -U ghen -d ghenapp -h localhost -c "SELECT version();"
# Should print the PostgreSQL version string
```

> **Windows note**: Replace `sudo -u postgres psql` with opening **SQL Shell (psql)** from the Start menu.

---

## 4. Redis Setup

### 4.1 Verify Redis is running

```bash
redis-cli ping
# PONG
```

### 4.2 (Optional) Set a Redis password

Edit `/etc/redis/redis.conf`:

```
requirepass your_redis_password
```

```bash
sudo systemctl restart redis-server
redis-cli -a your_redis_password ping
```

---

## 5. Backend Environment (`.env`)

Create `ghenapp/.env` (never commit this file):

```bash
cp ghenapp/.env.example ghenapp/.env   # if .env.example exists
# or create from scratch:
```

```ini
# ── App ───────────────────────────────────────────────────────
APP_ENV=development
PORT=8080

# ── Database ──────────────────────────────────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ghenapp
DB_USER=ghen
DB_PASSWORD=your_strong_password
DB_SSLMODE=disable

# ── Redis ─────────────────────────────────────────────────────
REDIS_ADDR=localhost:6379
REDIS_PASSWORD=                    # leave blank if no password
REDIS_DB=0

# ── JWT ───────────────────────────────────────────────────────
# Generate with: openssl rand -hex 32
JWT_SECRET=replace_with_64_char_random_hex_string
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=720h          # 30 days

# ── Snowflake ─────────────────────────────────────────────────
SNOWFLAKE_MACHINE_ID=1             # unique per server node (0–1023)

# ── File Uploads ──────────────────────────────────────────────
UPLOAD_PATH=./uploads
MAX_UPLOAD_BYTES=2097152           # 2MB

# ── Web Push (VAPID) ──────────────────────────────────────────
# Auto-generated on first run to vapid_keys.json
# You can override here if you want to pin the keys:
# VAPID_SUBJECT=mailto:admin@ghen-app.my.id
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=

# ── Noise_XX ──────────────────────────────────────────────────
# Set to 1 to disable Noise transport (for local dev without frontend)
# NOISE_DISABLED=1
```

### Generate a secure JWT secret

```bash
# Linux / macOS
openssl rand -hex 32

# PowerShell (Windows)
[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

---

## 6. Run Database Migrations

All migrations live in `ghenapp/migrations/`. Run them in order:

```bash
cd ghenapp

# Set your database URL
export DATABASE_URL="postgres://ghen:your_strong_password@localhost:5432/ghenapp?sslmode=disable"

# Run all pending migrations
migrate -path migrations -database "$DATABASE_URL" up
```

**PowerShell:**
```powershell
$env:DATABASE_URL = "postgres://ghen:your_strong_password@localhost:5432/ghenapp?sslmode=disable"
migrate -path migrations -database $env:DATABASE_URL up
```

Expected output:
```
1/u 001_init (xxx ms)
2/u 002_indexes (xxx ms)
3/u 003_sender_keys (xxx ms)
4/u 004_conversation_mapping (xxx ms)
5/u 005_push_subscriptions (xxx ms)
```

### Verify tables exist

```bash
psql -U ghen -d ghenapp -h localhost -c "\dt"
```

You should see: `users`, `prekeys`, `conversations`, `conversation_members`, `messages`, `groups`, `group_members`, `invite_links`, `uploads`, `sessions`, `push_subscriptions`.

### Rolling back (if needed)

```bash
migrate -path migrations -database "$DATABASE_URL" down 1   # roll back 1 step
migrate -path migrations -database "$DATABASE_URL" down     # roll back all
```

---

## 7. Run the Backend

```bash
cd ghenapp

# Download all Go dependencies
go mod download

# Run tests to verify everything compiles
go test ./... -count=1

# Start the server
go run ./cmd/server/main.go
```

Expected startup output:

```
[main] PostgreSQL connected
[main] Redis connected
[push] generated new VAPID keys, stored at vapid_keys.json
[noise] server static pubkey: a3f1b2c4...
[ws] Noise_XX transport enabled (server pubkey: a3f1b2c4…)
[GhenApp] REST API  → http://localhost:8080
[GhenApp] WebSocket → ws://localhost:8080/ws
```

### Verify the health endpoint

```bash
curl http://localhost:8080/health
# {"status":"ok","app":"GhenApp","version":"0.1.0","env":"development","time":"..."}
```

> **Tip**: Set `NOISE_DISABLED=1` in `.env` if you want to test the WebSocket without the Noise handshake (plain WS mode, useful for debugging with `websocat`).

---

## 8. Frontend Environment

Create `ghenapp-web/.env.local`:

```ini
# Backend API base URL (no trailing slash)
VITE_API_URL=http://localhost:8080

# WebSocket base URL
VITE_WS_URL=ws://localhost:8080
```

**For production**:
```ini
VITE_API_URL=https://ghen-app.my.id
VITE_WS_URL=wss://ghen-app.my.id
```

---

## 9. Run the Frontend (Dev)

```bash
cd ghenapp-web

# Install dependencies
npm install

# Start the Vite dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

### First time flow

1. Navigate to **http://localhost:5173/register**
2. Enter a username → a 12-word BIP-39 recovery phrase is generated
3. **Write it down** — this is the only way to recover your account
4. Prekeys are uploaded to the server automatically
5. Navigate to **http://localhost:5173/login** to sign in

---

## 10. First-Run Smoke Test

With both backend and frontend running:

| Step | Action | Expected |
|---|---|---|
| 1 | Register **user-alice** | ✅ Success, redirected to chat |
| 2 | Open incognito tab → register **user-bob** | ✅ Success |
| 3 | As Alice: click **+** → type `user-bob` | ✅ X3DH session initiated |
| 4 | Send a message | ✅ Message appears with 🔒 indicator |
| 5 | As Bob: receive message | ✅ Decrypted text visible |
| 6 | Check backend logs | ✅ No plaintext payload logged |
| 7 | Click ⚙ → Enable push notifications | ✅ Browser permission prompt |

### Verify Noise_XX handshake

```bash
# Backend logs should show on WS connect:
# [ws/noise] Noise_XX established for <user-id>
```

---

## 11. Production Build

### Backend binary

```bash
cd ghenapp

# Build optimised binary
CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o ghenapp-server ./cmd/server/
```

**Windows (cross-compile for Linux VPS):**
```powershell
$env:CGO_ENABLED="0"; $env:GOOS="linux"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o ghenapp-server ./cmd/server/
```

### Frontend bundle

```bash
cd ghenapp-web
npm run build
# Output: ghenapp-web/dist/
```

---

## 12. VPS Deployment (Ubuntu 24.04 — Mono-repo Method)

This method involves cloning the entire repository directly onto the VPS. This is the simplest way to manage updates using `git pull`.

### 12.1 Create Consolidated Directory Structure

We will store everything under `/opt/ghenapp` to keep the system clean.

```bash
# Create the structure
sudo mkdir -p /opt/ghenapp/{repo,bin,data/uploads,data/keys,logs}

# Give your user ownership
sudo chown -R $USER:$USER /opt/ghenapp
```

### 12.2 Clone the Repository

```bash
cd /opt/ghenapp/repo
git clone https://github.com/nantaa/ghenapp-chat.git .
```

### 12.3 Build the Application on VPS

**Build Backend:**
```bash
cd /opt/ghenapp/repo/ghenapp
go build -o /opt/ghenapp/bin/ghenapp-server ./cmd/server/
```

**Build Frontend:**
```bash
cd /opt/ghenapp/repo/ghenapp-web
npm install
npm run build
```

### 12.4 Configure Production Environment

Create `/opt/ghenapp/.env`:

```ini
APP_ENV=production
PORT=8080

# ── Network ───────────────────────────────────────────────────
# VPS public IP : 103.191.92.143
# VPS private IP: 10.117.240.254
# Domain        : ghen-app.my.id

DB_HOST=localhost
DB_PORT=5432
DB_NAME=ghenapp
DB_USER=ghen
DB_PASSWORD=your_production_password
DB_SSLMODE=disable
REDIS_ADDR=localhost:6379
REDIS_PASSWORD=your_redis_password
SNOWFLAKE_MACHINE_ID=1
UPLOAD_PATH=/opt/ghenapp/data/uploads

# VAPID keys file path (auto-created on first run)
VAPID_KEYS_PATH=/opt/ghenapp/data/keys/vapid_keys.json
VAPID_SUBJECT=mailto:admin@ghen-app.my.id

# Generate: openssl rand -hex 32
JWT_SECRET=replace_with_64_char_random_hex_string
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=720h

# Set to 1 to disable Noise_XX (debugging only)
# NOISE_DISABLED=1
```

> **Note**: `DB_SSLMODE=disable` is safe when PostgreSQL is on the same host.
> For a remote DB server, set `DB_SSLMODE=require`.

### 12.5 Run Migrations

```bash
cd /opt/ghenapp/repo/ghenapp
export DATABASE_URL="postgres://ghen:your_production_password@localhost:5432/ghenapp?sslmode=disable"
migrate -path migrations -database "$DATABASE_URL" up
```

---

## 13. Nginx + TLS Configuration

### 13.1 Update Nginx Root

In your Nginx config (`/etc/nginx/sites-available/ghenapp`), update the root path to point to your built frontend:

```nginx
server {
    ...
    # ── Frontend (React SPA) ───────────────────────────────────
    root /opt/ghenapp/repo/ghenapp-web/dist;
    index index.html;
    ...
}
```

    # Cache static assets
    location ~* \.(js|css|png|jpg|svg|ico|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Service Worker — must not be cached
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # ── Backend REST API ───────────────────────────────────────
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # ── WebSocket (IMCP) ───────────────────────────────────────
    location /ws {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;   # keep WS alive for 1 hour
        proxy_send_timeout 3600s;
    }

    # ── Uploaded files ─────────────────────────────────────────
    location /files/ {
        proxy_pass       http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_buffering  off;
    }
}
```

### 13.2 Enable the site

```bash
ln -s /etc/nginx/sites-available/ghenapp /etc/nginx/sites-enabled/
nginx -t          # must print: configuration file ... syntax is ok
systemctl reload nginx
```

### 13.3 Obtain TLS certificate

```bash
certbot --nginx -d ghen-app.my.id -d www.ghen-app.my.id \
        --email admin@ghen-app.my.id --agree-tos --non-interactive

# Verify auto-renewal
certbot renew --dry-run
```

---

## 14. systemd Service

### 14.1 Create service file

```bash
nano /etc/systemd/system/ghenapp.service
```

```ini
[Unit]
Description=GhenApp IMCP Chat Server
Documentation=https://github.com/nantaa/ghenapp-chat
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=ghenapp
Group=ghenapp
WorkingDirectory=/opt/ghenapp
EnvironmentFile=/opt/ghenapp/.env
ExecStart=/opt/ghenapp/bin/ghenapp-server
Restart=always
RestartSec=5s

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/ghenapp/data/uploads /opt/ghenapp/data/keys /opt/ghenapp/logs

# Logging
StandardOutput=append:/opt/ghenapp/logs/ghenapp.log
StandardError=append:/opt/ghenapp/logs/ghenapp-error.log

[Install]
WantedBy=multi-user.target
```

> **Important**: `ReadWritePaths` must include `/opt/ghenapp/data/keys` where
> `vapid_keys.json` is written on first start. Missing this causes a permission
> error and the server will fail to start.

### 14.2 Enable and start

```bash
# Create the ghenapp system user (if not already)
sudo useradd -r -s /bin/false -d /opt/ghenapp ghenapp
sudo chown -R ghenapp:ghenapp /opt/ghenapp

systemctl daemon-reload
systemctl enable ghenapp
systemctl start ghenapp
systemctl status ghenapp   # should show: active (running)
```

### 14.3 View logs

```bash
# Follow live logs
journalctl -u ghenapp -f

# Or from the log files
tail -f /opt/ghenapp/logs/ghenapp.log
```

### 14.4 Log rotation

```bash
nano /etc/logrotate.d/ghenapp
```

```
/opt/ghenapp/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    sharedscripts
    postrotate
        systemctl kill -s USR1 ghenapp.service
    endscript
}
```

---

## 15. Environment Variable Reference

### Backend (`ghenapp/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `APP_ENV` | No | `development` | `development` or `production` |
| `PORT` | No | `8080` | HTTP + WS listen port |
| `JWT_SECRET` | **Yes** | — | 32-byte hex string for JWT signing |
| `JWT_EXPIRY` | No | `15m` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRY` | No | `720h` | Refresh token lifetime (30 days) |
| `DB_HOST` | No | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | No | `ghenapp` | Database name |
| `DB_USER` | No | `ghen` | Database user |
| `DB_PASSWORD` | No | `devpassword` | Database password |
| `DB_SSLMODE` | No | `disable` | `disable` (local) or `require` (prod) |
| `REDIS_ADDR` | No | `localhost:6379` | Redis address |
| `REDIS_PASSWORD` | No | *(empty)* | Redis password (if set) |
| `REDIS_DB` | No | `0` | Redis database index |
| `SNOWFLAKE_MACHINE_ID` | No | `1` | Unique node ID `0–1023` |
| `UPLOAD_PATH` | No | `./uploads` | Directory for uploaded files |
| `MAX_UPLOAD_BYTES` | No | `2097152` | Max file size (default 2MB) |
| `VAPID_SUBJECT` | No | `mailto:admin@ghen-app.my.id` | VAPID contact (mailto: or https:) |
| `NOISE_DISABLED` | No | *(unset)* | Set `1` to skip Noise_XX (dev only) |

### Frontend (`ghenapp-web/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | **Yes** | `http://localhost:8080` | Backend API base URL |
| `VITE_WS_URL` | **Yes** | `ws://localhost:8080` | WebSocket base URL |

---

## 16. Troubleshooting

### `required environment variable "JWT_SECRET" is not set`

The `.env` file is missing or empty. Make sure `ghenapp/.env` exists and contains `JWT_SECRET`.

---

### `db ping: connection refused`

PostgreSQL is not running or the credentials are wrong.

```bash
sudo systemctl status postgresql
psql -U ghen -d ghenapp -h localhost   # test credentials manually
```

---

### `redis ping: connection refused`

Redis is not running.

```bash
sudo systemctl status redis-server
redis-cli ping
```

---

### WebSocket connects but messages don't appear (Noise handshake fails)

1. Check browser console for `[push] Noise handshake failed`.
2. Ensure the backend is running with Noise enabled (no `NOISE_DISABLED=1`).
3. Verify the frontend can reach `/api/v1/noise/pubkey`:

```bash
curl http://localhost:8080/api/v1/noise/pubkey
# {"public_key": [...]}
```

4. Confirm the user has a stored Ed25519 private key in IndexedDB (register flow must have completed).

---

### Push notifications not delivered

1. Browser must be on **HTTPS** in production (push requires secure context).
2. Check `vapid_keys.json` was created in the backend's working directory.
3. Verify the push subscription was saved:

```bash
psql -U ghen -d ghenapp -h localhost -c "SELECT user_id, endpoint FROM push_subscriptions;"
```

4. Check browser notification permissions: `chrome://settings/content/notifications`.

---

### Migration error: `dirty database`

A previous migration failed halfway. Fix with:

```bash
migrate -path migrations -database "$DATABASE_URL" force <VERSION>
# e.g., force 4 to reset to version 4, then run `up` again
```

---

### Port 8080 already in use

```bash
# Linux
lsof -i :8080
kill -9 <PID>

# Windows PowerShell
netstat -ano | findstr :8080
Stop-Process -Id <PID>
```

---

## Appendix: Quick Local Dev Checklist

```bash
# Terminal 1 — PostgreSQL (if not running as service)
pg_ctl start

# Terminal 2 — Redis
redis-server

# Terminal 3 — Backend
cd "GhenApp - Chat/ghenapp"
go run ./cmd/server/main.go

# Terminal 4 — Frontend
cd "GhenApp - Chat/ghenapp-web"
npm run dev
```

Then open **http://localhost:5173** 🚀

---

*GhenApp Setup Guide — v1.0 | Updated 2026-05-06 | Domain: ghen-app.my.id | Public IP: 103.191.92.143 | Private IP: 10.117.240.254*
