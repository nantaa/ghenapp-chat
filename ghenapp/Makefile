# GhenApp Makefile
# Usage: make <target>

BINARY_NAME=ghenapp
BUILD_DIR=./build
MIGRATE=migrate
DB_URL=postgres://ghen:devpassword@localhost:5432/ghenapp?sslmode=disable

.PHONY: all build run dev clean test \
        docker-up docker-down \
        migrate-up migrate-down migrate-create \
        sqlc-gen

# ─── Build ────────────────────────────────────────────────────────────────────
all: build

build:
	@echo "==> Building $(BINARY_NAME)..."
	@mkdir -p $(BUILD_DIR)
	go build -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/server/
	@echo "==> Built: $(BUILD_DIR)/$(BINARY_NAME)"

run: build
	$(BUILD_DIR)/$(BINARY_NAME)

dev:
	@echo "==> Running in dev mode (hot-ish reload)..."
	go run ./cmd/server/

clean:
	@rm -rf $(BUILD_DIR)
	@echo "==> Cleaned"

# ─── Testing ──────────────────────────────────────────────────────────────────
test:
	go test ./... -v -race

test-short:
	go test ./... -short

# ─── Docker ───────────────────────────────────────────────────────────────────
docker-up:
	docker compose up -d
	@echo "==> Waiting for Postgres to be ready..."
	@sleep 3

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

# ─── Database Migrations ──────────────────────────────────────────────────────
migrate-up:
	$(MIGRATE) -path db/migrations -database "$(DB_URL)" up

migrate-down:
	$(MIGRATE) -path db/migrations -database "$(DB_URL)" down

migrate-drop:
	$(MIGRATE) -path db/migrations -database "$(DB_URL)" drop -f

migrate-create:
	@read -p "Migration name: " name; \
	$(MIGRATE) create -ext sql -dir db/migrations -seq $$name

# ─── sqlc ─────────────────────────────────────────────────────────────────────
sqlc-gen:
	cd db && sqlc generate

# ─── Setup (run once) ─────────────────────────────────────────────────────────
setup:
	@echo "==> Installing tools..."
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
	go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
	@echo "==> Tools installed"
	@echo "==> Run 'make docker-up && make migrate-up' to initialize DB"
