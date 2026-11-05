# GhenApp — AI & Developer Skills Directory

Welcome to the `.skill` directory. These files define step-by-step guides, automated scripts, and commands that AI assistants (like Antigravity, Claude, or Cursor) and human developers can refer to when building, testing, or deploying GhenApp.

## 📚 Skill Files

1.  **[Running Development Environment](run_dev.md)**: Steps to spin up databases, caches, backend API, and React frontend.
2.  **[Database & Query Management](db_migrations.md)**: Handling PostgreSQL migrations (`migrate`) and type-safe Go SQL code generation (`sqlc`).
3.  **[Testing Guidelines](testing.md)**: Running tests for backend transport security (Noise) and UI components.
4.  **[Build & Deploy](build_deploy.md)**: Building production bundles, deploying to the IDCloudHost VPS, and verifying key persistence.

---

## ⚡ Integration Tools

You can invoke common workflows directly from the project root using:
*   **GNU Make**: A root-level `Makefile` is integrated at the root to proxy commands.
    *   `make setup` — Bootstrap dependencies for both frontend and backend.
    *   `make dev-backend` — Start backend server.
    *   `make dev-frontend` — Start React frontend.
    *   `make db-up` / `make db-down` — Spin up PostgreSQL/Redis containers.
    *   `make migrate-up` — Run DB migrations.
    *   `make test` — Execute backend tests.
