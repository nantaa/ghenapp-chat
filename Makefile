# GhenApp Root Makefile
# Automatically proxies commands to backend (ghenapp) and frontend (ghenapp-web) directories.
# Refer to .skill/README.md for detailed descriptions of each workflow.

.PHONY: setup db-up db-down migrate-up migrate-down sqlc dev-backend dev-frontend test lint build-all help

help:
	@echo "========================================================================"
	@echo " GhenApp Root Makefile Command Guide                                    "
	@echo "========================================================================"
	@echo "  make setup          - Install dependencies (Go tools & NPM packages)"
	@echo "  make db-up          - Start Postgres & Redis Docker containers"
	@echo "  make db-down        - Stop database containers"
	@echo "  make migrate-up     - Run PostgreSQL schema migrations"
	@echo "  make migrate-down   - Rollback PostgreSQL migrations"
	@echo "  make sqlc           - Regenerate Go database bindings using sqlc"
	@echo "  make dev-backend    - Start Go API server in development mode"
	@echo "  make dev-frontend   - Start Vite frontend development server"
	@echo "  make test           - Execute backend test suites"
	@echo "  make lint           - Run eslint checks on frontend"
	@echo "  make build-all      - Compile Go backend and React frontend bundles"
	@echo "========================================================================"

setup:
	@echo "==> Setting up backend Go tools..."
	cd ghenapp && $(MAKE) setup
	@echo "==> Installing frontend dependencies..."
	cd ghenapp-web && npm install

db-up:
	cd ghenapp && $(MAKE) docker-up

db-down:
	cd ghenapp && $(MAKE) docker-down

migrate-up:
	cd ghenapp && $(MAKE) migrate-up

migrate-down:
	cd ghenapp && $(MAKE) migrate-down

sqlc:
	cd ghenapp && $(MAKE) sqlc-gen

dev-backend:
	cd ghenapp && $(MAKE) dev

dev-frontend:
	cd ghenapp-web && npm run dev

test:
	cd ghenapp && $(MAKE) test

lint:
	cd ghenapp-web && npm run lint

build-all:
	@echo "==> Building React frontend..."
	cd ghenapp-web && npm run build
	@echo "==> Building Go backend..."
	cd ghenapp && $(MAKE) build
