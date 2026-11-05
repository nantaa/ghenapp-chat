# Skill: Running Development Environment

This guide explains how to spin up the local multi-container database environment and start both the Go backend and React frontend.

## Prerequisite Tools
*   Docker & Docker Compose
*   Go (version 1.21+ recommended)
*   Node.js & npm

---

## 🏃 Step-by-Step Run Flow

### 1. Spin up Databases (PostgreSQL + Redis)
Run Docker Compose from the root directory to launch databases in background mode:
```bash
# Via Root Makefile:
make db-up

# Direct Command (run in ghenapp/):
cd ghenapp
docker compose up -d
```
*   **PostgreSQL**: Runs on port `5432` (user: `ghen`, password: `devpassword`, db: `ghenapp`).
*   **Redis**: Runs on port `6379`.

### 2. Run Database Migrations
Before starting the backend, ensure all schema migrations are applied:
```bash
# Via Root Makefile:
make migrate-up

# Direct Command (run in ghenapp/):
cd ghenapp
migrate -path db/migrations -database "postgres://ghen:devpassword@localhost:5432/ghenapp?sslmode=disable" up
```

### 3. Start Backend Server
Start the Go backend server (runs on port `4747` by default):
```bash
# Via Root Makefile:
make dev-backend

# Direct Command (run in ghenapp/):
cd ghenapp
go run ./cmd/server/
```
Verify the server is running by visiting:
`http://localhost:4747/api/v1/noise/pubkey` (returns the server's Noise static public key).

### 4. Start Frontend Development Server
In a separate terminal, start the Vite development server for the React client:
```bash
# Via Root Makefile:
make dev-frontend

# Direct Command (run in ghenapp-web/):
cd ghenapp-web
npm run dev
```
Open `http://localhost:5173` (or the port output by Vite) in your browser.

---

## 🛑 Stopping Dev Containers
To tear down the Docker containers and free up ports:
```bash
# Via Root Makefile:
make db-down

# Direct Command (run in ghenapp/):
cd ghenapp
docker compose down
```
