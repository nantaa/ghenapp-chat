# GhenApp — Build To-Do List (Batched)
> Derived from: `GhenApp_Project_Kickoff.md` + `IMCP_Protocol_Design_v0.3_FINAL.md`
> Stack: Go + Gin + sqlc + PostgreSQL + Redis | React 18 + TypeScript + Vite + TailwindCSS + Zustand
> Rule: Email / Push notifications → deferred (use defaults for now)

---

## 🟦 BATCH 1 — Project Scaffold & Local Dev Environment
> Goal: Working Go server + local database, ready for code

- [x] **1.1** Create project directory: `ghenapp/`
- [x] **1.2** Init Go module: `go mod init github.com/yourname/ghenapp`
- [x] **1.3** Install Go dependencies:
  - `github.com/gin-gonic/gin`
  - `github.com/gorilla/websocket`
  - `github.com/lib/pq`
  - `github.com/redis/go-redis/v9`
  - `github.com/golang-jwt/jwt/v5`
  - `github.com/google/flatbuffers/go`
- [x] **1.4** Create full project directory structure per kickoff doc:
  ```
  cmd/server/main.go
  internal/{auth, crypto, ws, message, group, user, upload, ratelimit, snowflake}/
  db/{migrations/, queries/, sqlc.yaml}
  config/config.go
  Makefile
  docker-compose.yml
  ```
- [x] **1.5** Write `docker-compose.yml` with PostgreSQL 16 + Redis 7-alpine (ports 5432, 6379)
- [x] **1.6** Write `.env` file (never commit) + `.env.example` (commit this)
- [x] **1.7** Write `config/config.go` — load all env vars (DB, Redis, JWT, Upload, Snowflake)
- [x] **1.8** Install `sqlc` + `golang-migrate` CLIs
- [x] **1.9** Write minimal `cmd/server/main.go` — Gin server starts, health endpoint `GET /health` returns `200 OK`
- [x] **1.10** Run `docker compose up -d` — confirm Postgres + Redis are healthy
- [x] **1.11** Confirm `go run ./cmd/server/main.go` starts without errors

---

## 🟦 BATCH 2 — Database Schema & Migrations
> Goal: Full schema created, sqlc queries generated, ready for use

- [x] **2.1** Write migration `001_init.up.sql` — create all tables:
  - `users` (id UUID, username, display_name, public_key BYTEA, key_version, tier, tier_expires_at, discoverable, created_at, last_seen_at)
  - `prekeys` (id, user_id FK, key_type, public_key BYTEA, signature BYTEA, used bool, created_at)
  - `conversations` (id, type `direct|group`, created_at)
  - `conversation_members` (conversation_id FK, user_id FK, joined_at)
  - `messages` (id BIGINT Snowflake PK, conversation_id, payload BYTEA, msg_type, timestamp, ttl_expires_at, delivered bool, created_at)
  - `groups` (id, name, description, created_by FK, max_members, created_at)
  - `group_members` (group_id FK, user_id FK, role `admin|member`, joined_at)
  - `invite_links` (token, group_id FK, created_by FK, expires_at, max_uses, use_count, revoked, created_at)
  - `uploads` (id, uploader_id FK, filename, mime_type, size_bytes, storage_path, created_at)
  - `sessions` (id, user_id FK, created_at, last_used_at, revoked bool)
  - `payments` (id, user_id FK, amount_idr, method, status, period_months, paid_at, created_at)
- [x] **2.2** Write migration `001_init.down.sql` — drop all tables in reverse order
- [x] **2.3** Write migration `002_indexes.up.sql` — add all indexes:
  - `idx_messages_conversation` on `messages(conversation_id, timestamp DESC)`
  - `idx_messages_ttl` on `messages(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL`
  - `idx_prekeys_user` on `prekeys(user_id, key_type, used)`
  - `idx_users_username` on `users(username)`
- [x] **2.4** Run migrations: `migrate -path db/migrations -database "postgres://..." up`
- [x] **2.5** Write `db/sqlc.yaml` config
- [x] **2.6** Write sqlc query files in `db/queries/`:
  - `users.sql` — insert, get by username, get by id, update last_seen, update tier
  - `prekeys.sql` — insert batch, get one available prekey by user, mark used
  - `messages.sql` — insert, get by conversation paginated, mark delivered, delete expired TTL
  - `conversations.sql` — insert, get by id, get conversations for user
  - `groups.sql` — insert, get by id, add member, remove member, list members
  - `invite_links.sql` — insert, get by token, increment use_count, revoke
  - `uploads.sql` — insert, get by id
  - `sessions.sql` — insert, revoke, get by id
  - `payments.sql` — insert, update status, get by user
- [ ] **2.7** Run `sqlc generate` — confirm Go types generated without errors

---

## 🟦 BATCH 3 — Core Auth, Snowflake, Rate Limiter
> Goal: Register + Login endpoints work, JWT issued, Snowflake IDs working, rate limiter active

### Snowflake ID Generator
- [x] **3.1** Implement `internal/snowflake/snowflake.go` — Twitter Snowflake 64-bit IDs
  - 41-bit timestamp ms | 10-bit machine ID | 12-bit sequence
  - Read `SNOWFLAKE_MACHINE_ID` from config
  - Monotonic clock, handle backward drift

### Auth System
- [x] **3.2** Implement `internal/auth/jwt.go` — sign/parse JWT access tokens (15-min expiry, HS256)
- [x] **3.3** Implement `internal/auth/refresh.go` — Redis refresh token:
  - Store: `SET session:{token} {user_id} EX 2592000` (30 days)
  - Validate: GET + check not revoked
  - Revoke: DEL key from Redis
- [x] **3.4** Implement `internal/auth/middleware.go` — Gin JWT middleware:
  - Extract Bearer token from `Authorization` header
  - Validate + inject `user_id` into Gin context
  - Return `401 Unauthorized` if invalid/expired

### Rate Limiter
- [x] **3.5** Implement `internal/ratelimit/limiter.go` — Redis sliding window rate limiter:
  - Per user identity (not per IP)
  - Configurable: messages/min, uploads/hour, connections/min
  - Free vs. Premium limits (read tier from DB)
  - Return `RATE_LIMITED` response on exceed

### User Registration & Login
- [x] **3.6** Implement `internal/user/handler.go` — REST handlers:
  - `POST /register` — username + Ed25519 public key → insert user, return JWT + refresh token
  - `POST /login` — username + signature challenge → verify Ed25519, issue JWT + refresh token
  - `POST /refresh` — exchange refresh token for new JWT
  - `POST /logout` — revoke refresh token in Redis
  - `GET /users/:username` — lookup user (public_key + display info)
  - `PUT /users/me` — update display_name, avatar, discoverable
- [ ] **3.7** Write unit tests for auth flow (register → login → refresh → logout)

---

## 🟦 BATCH 4 — WebSocket Server + Noise Handshake + IMCP Framing
> Goal: WebSocket connection lifecycle works end-to-end per IMCP spec

### WebSocket Handler
- [x] **4.1** Implement `internal/ws/hub.go` — connection registry:
  - Map of `user_id → *websocket.Conn`
  - Thread-safe add/remove/broadcast
  - Heartbeat goroutine: send Ping every 30s, close conn if no Pong within 10s
- [x] **4.2** Implement `internal/ws/handler.go` — Gin WebSocket upgrade:
  - `GET /ws` — upgrade HTTP → WebSocket
  - Enforce auth: read JWT from query param `?token=` (WS can't set headers)
  - Register connection in hub on connect
  - Deregister + clean up on disconnect

### Noise_XX Handshake
- [ ] **4.3** Implement `internal/crypto/noise.go` — Noise_XX_25519_ChaChaPoly_BLAKE2s:
  - Use a Go Noise library (e.g., `github.com/flynn/noise`)
  - Server-side handshake: respond to client Noise_XX initiation
  - After handshake: derive symmetric session keys for frame encryption
  - Wrap every WebSocket frame in Noise transport layer

### FlatBuffers Message Schema
- [x] **4.4** Write IMCP FlatBuffers schema (`.fbs` file):
  - `Message` table: id (uint64), conversation (bytes[32]), type (enum), payload (bytes), timestamp (uint64), ttl_seconds (uint32), padding (bytes)
  - `MessageType` enum: TEXT, IMAGE, VIDEO, AUDIO, FILE, STICKER, REACTION, SYSTEM, CALL_SIGNAL
  - Frame wrapper: version byte + message bytes
- [ ] **4.5** Generate Go FlatBuffers code from schema (`flatc --go`)
- [x] **4.6** Implement `internal/ws/frame.go` — encode/decode IMCP frames:
  - Parse incoming binary frame → FlatBuffers Message
  - Validate: schema, size (≤ 2MB for media), TTL
  - Encode outgoing Message → binary frame

---

## 🟦 BATCH 5 — Message Routing & Delivery
> Goal: Two users can send/receive encrypted messages through the server

### Message Router
- [x] **5.1** Implement `internal/message/router.go` — message delivery logic:
  - **Online path**: recipient in hub → Redis Pub/Sub publish → WebSocket push
  - **Offline path**: write to `messages` table (delivered=false) → deliver on reconnect
  - Server is passthrough — never decrypt payload
  - On reconnect: fetch undelivered messages from DB, push, mark delivered=true
- [x] **5.2** Implement Redis Pub/Sub channels:
  - Channel per user: `imcp:user:{user_id}`
  - Subscribe on WS connect, unsubscribe on disconnect
  - Publish message to channel → subscriber forwards to WebSocket

### Pre-Key Bundle (X3DH Support)
- [x] **5.3** Implement pre-key endpoints in `internal/user/handler.go`:
  - `POST /prekeys` — upload batch of one-time prekeys + signed prekey + signature
  - `GET /prekeys/:username` — fetch one available prekey bundle for X3DH
  - Auto-mark fetched prekey as used

### End-to-End Milestone Test
- [ ] **5.4** Manual end-to-end test (per Kickoff Step 5):
  - Register User A → upload prekey bundle ✅
  - Register User B → upload prekey bundle ✅
  - User A fetches User B's prekey bundle ✅
  - User A computes X3DH shared secret (client-side) ✅
  - User A sends encrypted "hello" → server ✅
  - Server stores/routes → User B receives ✅
  - User B decrypts → "hello" visible ✅

---

## 🟨 BATCH 6 — Group Chat + Invite Links
> Goal: Group chat functional with Sender Keys

- [x] **6.1** Implement `internal/group/handler.go`:
  - `POST /groups` — create group (admin = creator)
  - `GET /groups/:id` — get group info + member list
  - `POST /groups/:id/members` — add member (admin only)
  - `DELETE /groups/:id/members/:uid` — remove member (admin only)
  - `POST /groups/:id/invite` — generate invite link (expiry + max_uses required)
  - `POST /invite/:token/join` — join via invite link (validate: not expired, not over limit, not revoked)
  - `DELETE /groups/:id/invite/:token` — revoke invite link (admin only)
- [ ] **6.2** Implement Sender Keys distribution endpoints:
  - `POST /groups/:id/sender-key` — upload my sender key (encrypted for each member)
  - `GET /groups/:id/sender-keys` — fetch all member sender keys
- [x] **6.3** Group message routing — broadcast encrypted payload to all online members, queue for offline members
- [ ] **6.4** TTL / disappearing messages:
  - Parse `ttl_seconds` from message frame
  - Store `ttl_expires_at` in DB
  - Background goroutine: DELETE expired messages every 5 min

---

## 🟨 BATCH 7 — File Uploads + Store & Forward Hardening
> Goal: File upload working (2MB limit), offline delivery robust

- [x] **7.1** Implement `internal/upload/handler.go`:
  - `POST /upload` — multipart file upload
  - Server-side size check: reject if > 2MB (hard limit)
  - Store to `UPLOAD_PATH` on local disk
  - Insert record into `uploads` table
  - Return upload URL/ID for embedding in message payload
- [x] **7.2** Serve uploaded files: `GET /files/:id` — auth-gated file download
- [ ] **7.3** Harden offline delivery:
  - On reconnect, send all undelivered messages from DB in chronological order
  - After confirmed delivery, mark `delivered = true`
  - Background job: auto-purge messages older than 3 years
- [ ] **7.4** BIP-39 account recovery endpoints:
  - `POST /backup` — accept encrypted history blob, store associated with user
  - `GET /backup` — return encrypted blob for authenticated user
  - (Key derivation from 12-word phrase is client-only; server just stores blob)

---

## 🟩 BATCH 8 — React Web Client Foundation
> Goal: React app scaffold, connects to backend WebSocket

- [ ] **8.1** Scaffold React app: `npm create vite@latest ghenapp-web -- --template react-ts`
- [ ] **8.2** Install frontend dependencies:
  - `tailwindcss` + config
  - `zustand` (state management)
  - `libsodium-wrappers` + `@types/libsodium-wrappers`
  - `flatbuffers` (npm)
  - `idb` (IndexedDB wrapper for key storage)
- [ ] **8.3** Setup Zustand stores:
  - `authStore` — user identity, JWT, session state
  - `chatStore` — conversations, messages (in-memory)
  - `cryptoStore` — in-memory session keys (never persisted as plaintext)
- [ ] **8.4** Implement `src/crypto/` — client-side crypto:
  - `keygen.ts` — Ed25519 keypair generation via libsodium
  - `x3dh.ts` — X3DH key exchange (sender side + receiver side)
  - `ratchet.ts` — Double Ratchet encrypt/decrypt
  - `storage.ts` — AES-256 encrypted IndexedDB key store
  - `bip39.ts` — derive mnemonic from seed, recover seed from mnemonic
- [ ] **8.5** Implement `src/ws/` — WebSocket client:
  - Connect to `wss://{HOST}:4747/ws?token={jwt}`
  - Noise_XX handshake (client side)
  - Encode/decode FlatBuffers frames
  - Auto-reconnect with exponential backoff: 1s → 2s → 4s → 8s → max 30s
  - Heartbeat: respond to server Ping with Pong

---

## 🟩 BATCH 9 — Chat UI (1-to-1 + Group)
> Goal: Fully functional chat interface

- [ ] **9.1** Registration screen:
  - Username input → generate Ed25519 keypair → show 12-word BIP-39 phrase → confirm saved → POST `/register`
  - Store encrypted private key in IndexedDB
- [ ] **9.2** Login screen:
  - Username input → sign challenge with private key → POST `/login` → store JWT
  - Account recovery: enter 12-word phrase → derive key → fetch encrypted backup → decrypt
- [ ] **9.3** Main chat layout:
  - Left sidebar: conversation list (sorted by latest message)
  - Center: active conversation message thread
  - Right (optional): contact/group info panel
- [ ] **9.4** 1-to-1 chat:
  - Start new chat: search username → fetch prekey bundle → X3DH → open conversation
  - Send message: Double Ratchet encrypt → send FlatBuffers frame via WS
  - Receive message: decode frame → Double Ratchet decrypt → display
  - Typing indicator: send `SYSTEM` frame type `typing_start` / `typing_stop`
  - Read receipt: send `SYSTEM` frame type `read` on message render
- [ ] **9.5** Group chat:
  - Create group, add members, manage invite links (admin UI)
  - Fetch + distribute Sender Keys on group join
  - Group message encrypt/decrypt using Sender Keys
  - Member list, role badges (admin / member)
- [ ] **9.6** TOFU trust flow:
  - On first message to new contact: silently accept (TOFU default)
  - Key change detected: show friendly in-chat warning banner → "I trust this new key" button
- [ ] **9.7** Media messages:
  - Image/video/audio/file: client-side compress (if image/video) → POST `/upload` → embed upload ID in message payload
  - Render inline image previews, audio player, file download button

---

## 🟩 BATCH 10 — WebRTC Calls + Disappearing Messages UI
> Goal: 1-to-1 voice/video calls work, TTL messages functional

- [ ] **10.1** WebRTC call signaling:
  - Caller sends `CALL_SIGNAL` frame (SDP offer) via WS
  - Server relays to recipient's WS
  - Recipient responds with SDP answer + ICE candidates
  - TURN server config (fallback if P2P fails — set up coturn or use a public TURN)
- [ ] **10.2** Call UI:
  - Incoming call screen: accept / decline
  - Active call screen: mute, camera toggle, end call
  - Display call status: connecting → connected → ended
- [ ] **10.3** Disappearing messages UI:
  - Per-conversation TTL selector: 1h / 1d / 1w / custom
  - Show "disappearing on" indicator in chat header
  - Client clears messages from local store when TTL expires

---

## 🟧 BATCH 11 — Freemium Gate + Payment Flow (Manual QR)
> Goal: Free vs. Premium enforced, manual QR payment flow works

- [ ] **11.1** Backend: Premium tier enforcement:
  - All rate limit checks read `tier` from user record
  - Endpoints for tier-gated features (onion routing, HD calls) check `tier = 'premium'` and `tier_expires_at > NOW()`
- [ ] **11.2** Payment endpoints:
  - `POST /payments` — create payment record (status: pending), return QR placeholder data
  - `POST /payments/:id/confirm` — admin-only endpoint, sets `status = 'paid'`, updates `tier = 'premium'`, sets `tier_expires_at = NOW() + 30 days`
  - `GET /payments/me` — user payment history
- [ ] **11.3** Frontend: Upgrade screen:
  - Show feature comparison table (Free vs. Premium)
  - "Upgrade" button → POST `/payments` → show QR code / bank transfer info
  - Poll `GET /payments/:id` until status = 'paid' → unlock Premium badge
- [ ] **11.4** Admin panel (minimal, web-based):
  - List pending payments
  - Confirm payment button → calls `POST /payments/:id/confirm`
  - Simple password-protected page (no framework needed for v1)

---

## 🟥 BATCH 12 — VPS Deployment + TLS + Nginx
> Goal: App running live on IDCloudHost VPS

- [ ] **12.1** Provision IDCloudHost VPS: Ubuntu 24.04 LTS, 2 vCPU / 4GB RAM / 80GB SSD
- [ ] **12.2** Install on VPS: Go, PostgreSQL 16, Redis 7, Nginx, Certbot
- [ ] **12.3** Write Nginx config:
  - Proxy `/ws` → `localhost:4747` (WebSocket upgrade headers)
  - Proxy `/api` → `localhost:8080` (REST)
  - Redirect HTTP → HTTPS
- [ ] **12.4** Obtain TLS certificate: `certbot --nginx`
- [ ] **12.5** Run DB migrations on production Postgres
- [ ] **12.6** Build Go binary: `go build -o ghenapp ./cmd/server/` → copy to VPS
- [ ] **12.7** Create systemd service `ghenapp.service` — auto-restart on crash
- [ ] **12.8** Build React frontend: `npm run build` → copy `dist/` to Nginx web root
- [ ] **12.9** Smoke test: register 2 users, send message, confirm delivery

---

## 🟥 BATCH 13 — Monitoring + Security Hardening
> Goal: Observability in place, production-safe

- [ ] **13.1** Install Prometheus + Grafana on VPS (internal ports only)
- [ ] **13.2** Add Prometheus metrics to Go server:
  - Active WebSocket connections
  - Messages/sec
  - Rate-limit hit count
  - DB query latency
  - File upload count + total bytes
- [ ] **13.3** Create Grafana dashboard for all metrics
- [ ] **13.4** Security hardening checklist:
  - Confirm server never logs decrypted message content ✅
  - Confirm server never stores private keys ✅
  - File size hard-reject server-side (≤ 2MB) ✅
  - Rate limiter active before any DB write ✅
  - `.env` not committed (only `.env.example`) ✅
  - All DB queries through sqlc (no raw strings) ✅
  - JWT secret rotated from dev default ✅
- [ ] **13.5** Set up log rotation for Go server logs (logrotate)
- [ ] **13.6** Set up disk usage monitoring + upload quota alerts

---

## ⏸️ DEFERRED (Later)
> Skip for now — revisit after core is stable

| Item | Reason |
|---|---|
| Web Push / VAPID notifications | Set up later |
| Email (any kind) | Not needed yet |
| Xendit payment integration | Phase 5 |
| 2-hop onion routing (Premium) | Phase 4 |
| Flutter mobile client | Phase 5 |
| WebRTC group calls | Phase 5 |
| Quantum-resistant crypto (Kyber) | Future |
| PCT patent filing | When lawyer ready |

---

## 📋 Quick Reference — Development Rules
1. Never log decrypted message content
2. Never store private keys — only public keys touch server
3. Always validate file size server-side (client-side = UX only)
4. Rate limit BEFORE any DB write
5. All DB queries through sqlc — no raw strings
6. Test crypto primitives with known test vectors
7. Commit `.env.example`, never `.env`
8. Tag every release — protocol version in every message frame

---

*GhenApp / IMCP Build Plan — v1.0*
*Status: Ready to build Batch 1 🚀*
