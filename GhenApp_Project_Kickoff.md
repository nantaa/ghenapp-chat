# GhenApp — Project Kickoff Document
> IndoMade Chat Protocol (IMCP) | Phase 1 Start
> Classification: PROPRIETARY

---

## Project Summary

| Property | Value |
|---|---|
| App name | **GhenApp** |
| Protocol | IndoMade Chat Protocol (IMCP) |
| Stage | Pre-development → Phase 1 |
| Developer | Solo (you) |
| Target users | 1K prototype → 1M commercial |
| VPS | IDCloudHost |
| Stack | Go + Gin + sqlc + PostgreSQL + Redis + React |

---

## All Decisions — Locked ✅

Every architectural decision has been made. Nothing is ambiguous.

### Infrastructure
- VPS: IDCloudHost
- OS: Ubuntu 24.04 LTS (recommended)
- Port: 4747 (WebSocket)
- Server address: IP-based (no domain for prototype)
- TLS: Let's Encrypt via Certbot

### Backend
- Language: Go
- Framework: Gin
- Query layer: sqlc
- Database: PostgreSQL
- Cache/broker: Redis
- File storage: Local VPS disk
- ID generation: Twitter Snowflake
- Session: JWT (15min) + Redis refresh token (30 days)

### Protocol
- Transport: WebSocket (wss://) + auto ws:// fallback, port 4747
- Encryption: X3DH + Double Ratchet (1-to-1), Sender Keys (groups)
- Transport security: Noise_XX_25519_ChaChaPoly_BLAKE2s
- Message format: FlatBuffers (binary)
- Calls: WebRTC (browser-native)
- Push: Web Push API + Service Worker

### Client (v1)
- Platform: Web browser
- Stack: React 18 + TypeScript + Vite + TailwindCSS + Zustand
- Crypto: libsodium-wrappers + WebCrypto API
- Key storage: IndexedDB (encrypted)

### Business
- Model: Freemium
- Price: Rp. 25.000/month
- Launch promo: Free 3 months for first 100 users
- Payment v1: QR manual
- Payment v2: Xendit
- Jurisdiction: Indonesia (PDP Law compliant)
- Patent: PCT international filing (attorney TBD)

---

## Phase 1 Task List

> Start here. Complete in order.

### Step 1 — Go Project Scaffold
```bash
mkdir ghenapp && cd ghenapp
go mod init github.com/yourname/ghenapp
go get github.com/gin-gonic/gin
go get github.com/gorilla/websocket
go get github.com/lib/pq
go get github.com/redis/go-redis/v9
go get github.com/golang-jwt/jwt/v5
```

### Step 2 — Project Structure
```
ghenapp/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── auth/           # JWT + session
│   ├── crypto/         # X3DH, Double Ratchet, Noise
│   ├── ws/             # WebSocket handler
│   ├── message/        # Message routing + delivery
│   ├── group/          # Group chat logic
│   ├── user/           # User registration, key store
│   ├── upload/         # File upload handler
│   ├── ratelimit/      # Redis-based rate limiter
│   └── snowflake/      # Snowflake ID generator
├── db/
│   ├── migrations/     # SQL migration files
│   ├── queries/        # sqlc query files
│   └── sqlc.yaml
├── config/
│   └── config.go
├── Makefile
└── docker-compose.yml  # local dev (PG + Redis)
```

### Step 3 — Database Setup
```bash
# Install sqlc
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# Run migrations (use golang-migrate)
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
migrate -path db/migrations -database "postgres://..." up
```

### Step 4 — Local Dev Environment
```yaml
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: ghenapp
      POSTGRES_USER: ghen
      POSTGRES_PASSWORD: devpassword
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

### Step 5 — First Milestone
Build and test this flow end-to-end:
```
Register User A → Upload prekey bundle
Register User B → Upload prekey bundle
User A fetches User B's prekey bundle
User A computes shared secret (X3DH)
User A sends encrypted "hello" → server
Server stores/routes → User B receives
User B decrypts → "hello" visible ✅
```

---

## Environment Variables

```env
# .env (never commit this)
APP_ENV=development
PORT=4747
JWT_SECRET=your-secret-here
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=720h

DB_HOST=localhost
DB_PORT=5432
DB_NAME=ghenapp
DB_USER=ghen
DB_PASSWORD=devpassword

REDIS_ADDR=localhost:6379
REDIS_PASSWORD=

UPLOAD_PATH=/var/ghenapp/uploads
MAX_UPLOAD_BYTES=2097152

VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

SNOWFLAKE_MACHINE_ID=1
```

---

## Development Rules

1. **Never log decrypted message content** — server is a passthrough
2. **Never store private keys** — only public keys touch the server
3. **Always validate file size server-side** — client-side check is UX only
4. **Rate limit before any DB write** — protect against spam/DDoS
5. **All DB queries through sqlc** — no raw string queries
6. **Test crypto primitives with known test vectors** — never guess
7. **Commit .env.example, never .env**
8. **Tag every release** — protocol version in every message frame

---

## Key Risks to Watch

| Risk | Mitigation |
|---|---|
| Crypto implementation bugs | Use libsodium bindings, not manual crypto |
| WebSocket connection drops | Exponential backoff reconnect on client |
| Snowflake clock skew | Use monotonic clock, handle backward drift |
| Redis unavailable | Fallback to DB queue for delivery |
| File disk full | Monitor disk usage, set upload quotas |
| Key recovery phrase lost | Educate user at registration — no server recovery |
| PDP Law violation | No plaintext PII stored, privacy policy ready for launch |

---

## First Week Goal

By end of week 1, you should have:
- [ ] Go project running locally
- [ ] PostgreSQL + Redis running via Docker Compose
- [ ] `/register` endpoint working (username + public key stored)
- [ ] `/ws` WebSocket endpoint accepting connections
- [ ] JWT issued on login
- [ ] Snowflake ID generator working
- [ ] First message sent and stored in DB (even if not encrypted yet)

---

## Contacts & Resources

| Resource | Link |
|---|---|
| IMCP Spec | `IMCP_Protocol_Design_v0.3_FINAL.md` |
| IDCloudHost | https://idcloudhost.com |
| sqlc docs | https://docs.sqlc.dev |
| libsodium-wrappers | https://www.npmjs.com/package/libsodium-wrappers |
| Gin docs | https://gin-gonic.com/docs |
| WebRTC MDN | https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API |
| BIP-39 wordlist | https://github.com/trezor/python-mnemonic/blob/master/src/mnemonic/wordlist/english.txt |
| PDP Law (Indonesia) | UU No. 27 Tahun 2022 |
| PCT Patent filing | https://www.wipo.int/pct/en |

---

*GhenApp / IMCP — Project Kickoff*
*Status: Ready to build 🚀*
*Classification: PROPRIETARY*
