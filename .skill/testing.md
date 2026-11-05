# Skill: Testing Guidelines

This guide details how to execute tests across the backend and verify security protocol handshakes (Noise).

---

## 🧪 Running Backend Tests

Go unit tests are structured in packages (e.g., `internal/ws`, `internal/message`).

### Run All Tests
Runs all unit tests recursively with race condition checking and verbose logging:
```bash
# Via Root Makefile:
make test

# Direct Command (run in ghenapp/):
cd ghenapp
go test ./... -v -race
```

### Run Short Tests
Excludes long-running tests:
```bash
# Direct Command (run in ghenapp/):
cd ghenapp
go test ./... -short
```

### Run WebSocket Handshake Tests Specifically
To test the Noise handshake protocol and WebSocket message framing:
```bash
cd ghenapp
go test ./internal/ws -v -run TestNoiseHandshake
```

---

## 🔬 Running Frontend Linters & Build Check
Ensure that the React frontend is compliant and does not contain compilation errors:
```bash
cd ghenapp-web
npm run lint
npm run build
```
*   `npm run lint` executes ESLint rules.
*   `npm run build` triggers TS compilation checks followed by the Vite production build.
