# Skill: Database & Query Management

This guide explains how to add new PostgreSQL migrations, run them, and regenerate type-safe Go database queries using `sqlc`.

## 🛠️ Tools Required
*   `migrate` (golang-migrate CLI): Used for versioning schema migrations.
*   `sqlc`: Generates type-safe Go code from raw SQL queries.

---

## 💾 Running Migrations

### Apply Migrations (Up)
Applies all pending migrations to the database.
```bash
# Via Root Makefile:
make migrate-up

# Direct Command:
migrate -path ghenapp/db/migrations -database "postgres://ghen:devpassword@localhost:5432/ghenapp?sslmode=disable" up
```

### Rollback Migrations (Down)
Rolls back the latest migration batch.
```bash
# Via Root Makefile:
make migrate-down

# Direct Command:
migrate -path ghenapp/db/migrations -database "postgres://ghen:devpassword@localhost:5432/ghenapp?sslmode=disable" down
```

---

## ➕ Creating a New Migration
To create a new sequential migration step:
```bash
# Direct Command (run in ghenapp/):
cd ghenapp
migrate create -ext sql -dir db/migrations -seq <migration_name>
```
This will generate two files:
*   `db/migrations/XXX_<migration_name>.up.sql` (Add your schema updates here)
*   `db/migrations/XXX_<migration_name>.down.sql` (Add your rollback logic here)

---

## 🔄 Regenerating Go Code with sqlc
If you modify database schemas or add new queries in `ghenapp/db/queries/`:
1.  Verify the queries in `ghenapp/db/queries/*.sql`.
2.  Run the generator:
    ```bash
    # Via Root Makefile:
    make sqlc

    # Direct Command (run in ghenapp/):
    cd ghenapp
    cd db && sqlc generate
    ```
This will regenerate type-safe Go structs and functions in `ghenapp/internal/db/` mapping to your PostgreSQL queries.
