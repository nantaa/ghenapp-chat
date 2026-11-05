# Skill: Build & Deploy Workflow

This guide details the procedure for compiling and deploying production builds of GhenApp's backend and frontend to the IDCloudHost VPS.

---

## 🏗️ Production Build Commands

### 1. Build React Frontend (Static Dist Bundle)
```bash
cd ghenapp-web
npm run build
```
Generates a static production bundle in `ghenapp-web/dist/`.

### 2. Build Go Backend (Executable Binary)
```bash
cd ghenapp
go build -o build/ghenapp ./cmd/server
```
Compiles a Linux/Windows binary dependent on target OS (e.g. `ghenapp` or `ghenapp.exe`) inside `ghenapp/build/`.

---

## 🚀 Deployment Steps (On VPS)

The GhenApp VPS runs Ubuntu with systemd managing the backend service, Nginx serving as the reverse proxy, and Let's Encrypt for SSL certificates.

### 1. Pull Latest Source
```bash
cd /opt/ghenapp/repo
git pull origin main
```

### 2. Rebuild & Deploy Frontend
Build the frontend, then copy the static production output to the Nginx root directory:
```bash
cd /opt/ghenapp/repo/ghenapp-web
npm run build
sudo cp -r dist/. /var/www/ghenapp/
```

### 3. Rebuild & Restart Backend
Stop the systemd service, compile the Go server binary, and start it back up:
```bash
sudo systemctl stop ghenapp
cd /opt/ghenapp/repo/ghenapp
go build -o /opt/ghenapp/bin/ghenapp ./cmd/server
sudo systemctl start ghenapp
```

### 4. Run Migrations (If Schema Changed)
Execute any new PostgreSQL migrations:
```bash
migrate -path db/migrations -database "postgres://ghen:Ghenapp123%23@localhost:5432/ghenapp?sslmode=disable" up
```

### 5. Restart Backend & Verify
Restart the service to load all changes and verify status:
```bash
sudo systemctl restart ghenapp
sudo systemctl status ghenapp --no-pager
```

---

## 🔍 Verification

### Verify Noise Key Stability
When the backend restarts, it must retain the same cryptographic identity. Check the public key stability by querying the endpoint twice:
```bash
# Query 1
curl -s https://ghen-app.my.id/api/v1/noise/pubkey

# Restart Backend
sudo systemctl restart ghenapp

# Query 2
curl -s https://ghen-app.my.id/api/v1/noise/pubkey
```
*   If both queries return the **identical** public key, the migration successfully persisted the key.
*   If keys differ, the database connection failed or migrations did not run. Check logs with:
    `sudo journalctl -u ghenapp -n 50`
