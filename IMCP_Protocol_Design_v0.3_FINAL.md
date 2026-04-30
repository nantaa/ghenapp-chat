# IndoMade Chat Protocol (IMCP)
> Version 0.3 — FINAL DRAFT | Status: Ready for Implementation
> App Name: **GhenApp** | Protocol: IMCP
> Classification: PROPRIETARY — DO NOT DISTRIBUTE

---

## 1. Overview

**IndoMade Chat Protocol (IMCP)** is a proprietary, speed-optimized secure messaging protocol
powering **GhenApp** — a commercial freemium chat application built and operated from Indonesia.

IMCP is designed to be:
- **Speed-first** — fast WebSocket delivery, binary FlatBuffers format
- **Secure** — mandatory E2E encryption, peer-reviewed primitives only
- **Lightweight** — 2MB file cap, minimal overhead, efficient binary encoding
- **Web-first** — primary client is the browser (React + TypeScript)
- **Commercial** — proprietary, freemium model, international patent filing intended
- **Indonesian** — hosted on IDCloudHost VPS, PDP Law compliant, priced for local market

---

## 2. Identity Card

| Property | Value |
|---|---|
| Protocol name | IndoMade Chat Protocol (IMCP) |
| App name | GhenApp |
| Version | 0.3 (pre-implementation) |
| Primary goal | Speed |
| Transport | WebSocket (wss://) + auto HTTP fallback |
| Port | **4747** |
| Server address | IP-based (no domain for prototype) |
| VPS provider | **IDCloudHost** |
| Jurisdiction | Indonesia |
| PDP Law compliant | Yes |
| Business entity | Personal (sole proprietor, for now) |
| Business model | Freemium |
| Pricing | Free 3 months for first 100 users → Rp. 25.000/month |
| Payment (v1) | QR code only (manual) |
| Payment (v2) | Xendit integration |
| Patent | International filing (PCT) — attorney TBD |
| Classification | Proprietary |

---

## 3. Protocol Stack

```
┌──────────────────────────────────────────────────────────────┐
│                    IMCP PROTOCOL STACK                        │
│                        (GhenApp)                              │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                APPLICATION LAYER (L5)                   │ │
│  │   Text · Image · Video · Audio · File · Calls (WebRTC)  │ │
│  │   Groups · Reactions · Disappearing · Read · Typing     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 IDENTITY LAYER (L4)                     │ │
│  │   Username + Ed25519 Keypair · TOFU · Key Directory     │ │
│  │   12-Word BIP-39 Recovery · Portable Identity           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               ENCRYPTION LAYER (L3)                     │ │
│  │   X3DH Key Exchange · Double Ratchet (1-to-1)           │ │
│  │   Sender Keys (groups) · Noise_XX Transport             │ │
│  │   ChaCha20-Poly1305 · Ed25519 · X25519 · BLAKE2s        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 ROUTING LAYER (L2)                      │ │
│  │   Server Relay (default) · Store & Forward (3yr TTL)    │ │
│  │   2-Hop Onion (premium) · Uniform Envelope Padding      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                TRANSPORT LAYER (L1)                     │ │
│  │   WebSocket over TLS 1.3 (wss://) — Port 4747           │ │
│  │   Auto fallback: ws:// plain HTTP (local dev)           │ │
│  │   Browser-native · No QUIC required                     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Layer Specifications

### 4.1 Transport Layer (L1)

| Property | Value |
|---|---|
| Primary | WebSocket over TLS 1.3 (`wss://`) |
| Fallback | Plain WebSocket (`ws://`) — auto, for local dev/test |
| Port | **4747** |
| Fallback trigger | Automatic — client detects TLS failure, downgrades silently |
| Frame format | Binary (FlatBuffers) |
| Heartbeat | Ping/pong every 30 seconds to keep connection alive |
| Reconnect | Exponential backoff: 1s → 2s → 4s → 8s → max 30s |

**WebSocket Connection Lifecycle:**
```
Client                            IMCP Server (:4747)
  │                                      │
  │── GET /ws (Upgrade: websocket) ─────►│
  │◄─ 101 Switching Protocols ───────────│
  │                                      │
  │── Noise_XX Handshake ───────────────►│
  │◄─ Handshake ACK ─────────────────────│
  │                                      │
  │── Auth Frame (session token) ───────►│
  │◄─ Auth OK ───────────────────────────│
  │                                      │
  │◄──────── Encrypted Frames ──────────►│
```

---

### 4.2 Routing Layer (L2)

**Centralized only. No P2P. No federation.**

```
Mode 1: Online Relay (default — all tiers)
  Sender ──► IMCP Server ──────────────► Recipient

Mode 2: Store & Forward (recipient offline — all tiers)
  Sender ──► IMCP Server ──► PG Queue ──► Recipient (on reconnect)
  Auto-delete after: 3 years

Mode 3: 2-Hop Onion (PREMIUM only)
  Sender ──► Relay Node A ──► Relay Node B ──► Recipient
  Server sees: encrypted blob only, not sender identity
```

**Envelope design:**
- All envelopes padded to uniform block size (prevent size-based analysis)
- Timestamps rounded to nearest second (prevent timing correlation)
- Sender ID excluded from server-visible header in onion mode

---

### 4.3 Encryption Layer (L3)

#### 1-to-1 Chat: X3DH + Double Ratchet
- X3DH for async key establishment (works if recipient offline)
- Double Ratchet for per-message forward secrecy + break-in recovery
- Each message uses a unique derived key — never reused

#### Group Chat: Sender Keys (Signal-style)
- Each member has their own sender key chain
- O(1) encryption cost regardless of group size
- New members: NO access to prior history (secure default)
- Future v2: optional encrypted history re-share (admin-controlled)

#### Transport: Noise Protocol
- Pattern: `Noise_XX_25519_ChaChaPoly_BLAKE2s`
- Provides mutual auth between client and server
- Wraps every WebSocket frame

#### Primitives

| Purpose | Algorithm | RFC |
|---|---|---|
| Key exchange | X25519 | RFC 7748 |
| Signatures | Ed25519 | RFC 8032 |
| Symmetric encryption | ChaCha20-Poly1305 | RFC 8439 |
| Hashing | BLAKE2s | RFC 7693 |
| KDF | HKDF | RFC 5869 |
| Randomness | OS CSPRNG | Platform |

> ⚠️ Zero custom cryptography. All primitives are IETF-standardized and peer-reviewed.
> Quantum resistance: deferred to future version.

---

### 4.4 Identity Layer (L4)

#### Identity Model
```
GhenApp Identity = Username + Ed25519 Keypair
```
- Username: 3–32 chars, alphanumeric + underscore
- Public key stored in server's **Public Key Directory** (indexed by username)
- Private key: stored **only on client** (IndexedDB, encrypted at rest)
- Identity is **portable** — recovery phrase works across IMCP-compatible servers

#### Trust: TOFU + Optional Upgrade
| Mode | Behavior |
|---|---|
| Default (TOFU) | Silent accept on first contact — smooth UX |
| Optional | QR code scan or safety number comparison |
| Backend | Public key directory enables key lookup + pinning |

#### Key Change Policy
- Key changes trigger a **friendly warning alert** to the contact
- Communication paused until user explicitly taps "I trust this new key"
- UX: non-scary, human-readable explanation (not a raw error)

#### Account Recovery: 12-Word BIP-39 Phrase
```
Registration:
  1. Generate Ed25519 keypair
  2. Derive 12-word BIP-39 mnemonic from private key seed
  3. Show phrase to user — store locally, NEVER send to server
  4. Encrypt message history backup → upload to server

Recovery:
  1. User enters 12-word phrase
  2. Client derives private key via HKDF
  3. Fetch encrypted backup from server
  4. Decrypt locally
  5. Identity + full message history restored ✅
```

#### User Discovery
- Users searchable by username
- Visibility toggle: public / hidden (user controls)
- Public profile: display name, avatar, bio (all optional)

---

### 4.5 Application Layer (L5)

#### Message Types & Size Limits

| Type | Max Size | Compression |
|---|---|---|
| `TEXT` | 4 KB | None |
| `IMAGE` | **2 MB** | Client-side before upload |
| `VIDEO` | **2 MB** | Client-side before upload |
| `AUDIO` | **2 MB** | Client-side before upload |
| `FILE` | **2 MB** | None |
| `STICKER` | 256 KB | None |
| `REACTION` | 64 B | None |
| `SYSTEM` | 1 KB | None |
| `CALL_SIGNAL` | 1 KB | WebRTC SDP/ICE |

> 2MB enforced server-side. Client compresses media before upload.

#### FlatBuffers Message Schema
```
// IMCP Wire Format (pseudoschema)
Message {
  id:             uint64      // Twitter Snowflake ID
  conversation:   bytes[32]   // hashed conversation ID
  type:           MessageType // enum (text/image/video/audio/file/etc)
  payload:        bytes       // E2E encrypted content
  timestamp:      uint64      // unix ms, rounded to nearest second
  ttl_seconds:    uint32      // 0 = no expiry, >0 = disappearing
  padding:        bytes       // random, uniform envelope size
}
```

#### Twitter Snowflake ID Structure
```
64 bits total:
[ 41 bits: timestamp ms ] [ 10 bits: machine ID ] [ 12 bits: sequence ]
→ ~69 years of IDs, 4096 IDs/ms/machine, time-sortable
```

#### Session Tokens: JWT + Redis Refresh
```
Auth Flow:
  1. Client registers → server issues:
     - JWT access token (short-lived: 15 minutes)
     - Opaque refresh token (stored in Redis, 30 days)
  2. Client uses JWT for all requests
  3. JWT expires → client uses refresh token → new JWT issued
  4. Logout → refresh token deleted from Redis (instant revoke)
```

#### Group Chat Spec

| Property | Value |
|---|---|
| Max members | 100 |
| Encryption | Sender Keys |
| Who can add members | Admin only |
| Invite links | ✅ Expiry time + max use count + admin-revocable |
| History for new members | ❌ None (secure default) |
| Future history sync | Encrypted re-share (v2, optional) |

#### Invite Link Schema
```
InviteLink {
  token:       string     // random 16-byte URL-safe token
  group_id:    UUID
  created_by:  UUID       // must be admin
  expires_at:  timestamp  // admin sets — required
  max_uses:    uint32     // 0 = unlimited
  use_count:   uint32     // auto-incremented
  revoked:     bool       // admin can kill anytime
}
```

#### Voice & Video Calls: WebRTC
- Signaling: IMCP server relays SDP offer/answer + ICE candidates
- Media: direct peer-to-peer WebRTC (SRTP encrypted)
- Fallback: TURN server relay if P2P hole-punch fails
- v1: audio + video (1-to-1)
- Premium: HD quality
- Group calls: v2

#### Web Push Notifications
- Service Worker registered on first login
- Web Push API (VAPID keys, server-side)
- Notifications when tab is closed/backgrounded
- Payload: encrypted (only "new message" hint, no content in push)

#### Disappearing Messages
- User sets TTL per conversation (not per message)
- Options: 1 hour / 1 day / 1 week / custom
- Server deletes after TTL expires
- Client also clears from local storage

---

## 5. Server Architecture

### Tech Stack (Locked)

| Component | Technology |
|---|---|
| Language | Go |
| HTTP/WS Framework | Gin |
| SQL Query Layer | sqlc (type-safe, no ORM) |
| Database | PostgreSQL |
| Session Store | Redis (refresh tokens + rate limit state) |
| Message Broker | Redis Pub/Sub (online delivery) |
| File Storage | Local VPS disk |
| Reverse Proxy | Nginx |
| TLS | Let's Encrypt (Certbot) |
| Monitoring | Prometheus + Grafana |
| VPS | IDCloudHost |

### Message Delivery Flow
```
Client sends message
        │
        ▼
Gin WebSocket Handler (port 4747)
        │
        ▼
Auth Middleware
  └── Validate JWT access token
        │
        ▼
Rate Limiter (per identity, Redis)
  └── Reject if over limit → return RATE_LIMITED frame
        │
        ▼
Message Validator
  └── Size check (>2MB → reject)
  └── Schema validation (FlatBuffers)
  └── TTL check
        │
        ▼
Encryption Passthrough
  └── Server NEVER decrypts payload
        │
        ├── Recipient online?
        │       └── YES → Redis Pub/Sub → WebSocket push (real-time)
        │
        └── Recipient offline?
                └── NO → PostgreSQL queue → deliver on reconnect
```

### Rate Limits

| Action | Free | Premium |
|---|---|---|
| Messages/minute | 60 | 300 |
| File uploads/hour | 20 | 100 |
| New connections/minute | 5 | 20 |
| Group invites/day | 10 | 50 |
| API calls/minute | 100 | 500 |

---

## 6. Database Schema

```sql
-- Users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(32) UNIQUE NOT NULL,
  display_name  VARCHAR(64),
  public_key    BYTEA NOT NULL,          -- Ed25519 public key
  key_version   INT DEFAULT 1,           -- increments on key change
  tier          VARCHAR(10) DEFAULT 'free', -- 'free' | 'premium'
  tier_expires_at TIMESTAMPTZ,
  discoverable  BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- Pre-keys (X3DH)
CREATE TABLE prekeys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users ON DELETE CASCADE,
  key_type      VARCHAR(10) NOT NULL,    -- 'signed' | 'onetime'
  public_key    BYTEA NOT NULL,
  signature     BYTEA,                   -- required for signed prekeys
  used          BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Messages (auto-purge after 3 years)
CREATE TABLE messages (
  id            BIGINT PRIMARY KEY,      -- Twitter Snowflake
  conversation_id UUID NOT NULL,
  payload       BYTEA NOT NULL,          -- encrypted blob
  msg_type      VARCHAR(20) NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,
  ttl_expires_at TIMESTAMPTZ,            -- NULL = no expiry
  delivered     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations
CREATE TABLE conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          VARCHAR(10) NOT NULL,    -- 'direct' | 'group'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation Members
CREATE TABLE conversation_members (
  conversation_id UUID REFERENCES conversations,
  user_id       UUID REFERENCES users,
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

-- Groups
CREATE TABLE groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  description   TEXT,
  created_by    UUID REFERENCES users,
  max_members   INT DEFAULT 100,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Group Members
CREATE TABLE group_members (
  group_id      UUID REFERENCES groups ON DELETE CASCADE,
  user_id       UUID REFERENCES users ON DELETE CASCADE,
  role          VARCHAR(10) DEFAULT 'member', -- 'admin' | 'member'
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- Invite Links
CREATE TABLE invite_links (
  token         VARCHAR(32) PRIMARY KEY,
  group_id      UUID REFERENCES groups ON DELETE CASCADE,
  created_by    UUID REFERENCES users,
  expires_at    TIMESTAMPTZ NOT NULL,
  max_uses      INT DEFAULT 0,           -- 0 = unlimited
  use_count     INT DEFAULT 0,
  revoked       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- File Uploads
CREATE TABLE uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id   UUID REFERENCES users,
  filename      VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    INT NOT NULL,            -- enforced <= 2MB
  storage_path  TEXT NOT NULL,          -- local VPS path
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions (refresh tokens)
-- Stored in Redis: key = "session:{token}", value = user_id, TTL = 30 days
-- Reference table for audit only
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked       BOOLEAN DEFAULT FALSE
);

-- Payment Records
CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users,
  amount_idr    INT NOT NULL,            -- in Rupiah
  method        VARCHAR(20) DEFAULT 'qr', -- 'qr' | 'xendit'
  status        VARCHAR(20) DEFAULT 'pending', -- 'pending'|'paid'|'failed'
  period_months INT DEFAULT 1,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_messages_conversation ON messages(conversation_id, timestamp DESC);
CREATE INDEX idx_messages_ttl ON messages(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;
CREATE INDEX idx_prekeys_user ON prekeys(user_id, key_type, used);
CREATE INDEX idx_users_username ON users(username);
```

---

## 7. Client Specification

### Platform Priority
1. **Web Browser** — v1 (React + TypeScript)
2. Mobile (Flutter) — v2
3. Desktop (Flutter) — v3

### Web Client Stack (v1 — GhenApp)

| Component | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | TailwindCSS |
| State management | Zustand |
| Crypto | `libsodium-wrappers` + WebCrypto API |
| WebSocket | Native browser WebSocket |
| Calls | WebRTC (native browser) |
| Push notifications | Web Push API + Service Worker |
| Key storage | IndexedDB (AES-256 encrypted) |
| Binary encoding | `flatbuffers` npm package |

---

## 8. Freemium Model

### Pricing
| Tier | Price | Notes |
|---|---|---|
| Free (launch promo) | Free for 3 months | First 100 users only |
| Free (standard) | Free forever | Limited features |
| Premium | **Rp. 25.000/month** | Full features |

### Payment Flow (v1 — QR Manual)
```
User requests premium upgrade
        │
        ▼
Server generates payment record (status: pending)
        │
        ▼
User shown QR code (QRIS / bank transfer)
        │
        ▼
Admin manually confirms payment
        │
        ▼
Server updates tier + sets tier_expires_at (+30 days)
        │
        ▼
User notified — premium activated ✅
```

### Payment Flow (v2 — Xendit)
- Xendit API integration
- Automatic confirmation via webhook
- Supports: QRIS, VA, e-wallet, credit card

### Feature Matrix

| Feature | Free | Premium |
|---|---|---|
| 1-to-1 messaging | ✅ | ✅ |
| Group chat (max 100) | ✅ | ✅ |
| File/image/video (2MB) | ✅ | ✅ |
| Voice/video calls (basic) | ✅ | ✅ |
| Disappearing messages | ✅ | ✅ |
| Read receipts | ✅ | ✅ |
| Typing indicators | ✅ | ✅ |
| Web Push notifications | ✅ | ✅ |
| 2-hop onion privacy mode | ❌ | ✅ |
| HD voice/video calls | ❌ | ✅ |
| Custom themes | ❌ | ✅ |
| Priority message delivery | ❌ | ✅ |
| Extended message backup | ❌ | ✅ |
| Larger groups (100+) | ❌ | ✅ (future) |

---

## 9. Security Properties

| Property | Status | How |
|---|---|---|
| Confidentiality | ✅ | ChaCha20-Poly1305 |
| Integrity | ✅ | Poly1305 MAC |
| Authentication | ✅ | Ed25519 signatures |
| Forward secrecy | ✅ | Double Ratchet |
| Break-in recovery | ✅ | Double Ratchet |
| Metadata privacy | ✅ (premium) | 2-hop onion routing |
| Replay protection | ✅ | Snowflake IDs + timestamps |
| Key change alerts | ✅ | Friendly warn + re-verify |
| Rate limiting | ✅ | Per-identity, tiered |
| Session revocation | ✅ | Redis-backed refresh tokens |
| File size enforcement | ✅ | Server-side hard reject |
| Server decryption | ❌ Never | Server is passthrough |
| Quantum resistance | ⏳ | Future version |

---

## 10. Deployment

```
IDCloudHost VPS
├── Ubuntu 24.04 LTS
├── Nginx (TLS termination, reverse proxy)
│     └── Proxy → localhost:4747 (IMCP WebSocket)
│     └── Proxy → localhost:8080 (REST API / admin)
├── GhenApp Go Server
│     ├── WebSocket handler (:4747)
│     └── REST API (:8080)
├── PostgreSQL (:5432, local only)
├── Redis (:6379, local only)
├── Certbot / Let's Encrypt (TLS certs)
├── Prometheus (:9090, internal)
├── Grafana (:3000, internal)
└── Local file storage (/var/ghenapp/uploads)
```

**Estimated spec for 1K users:**
- 2 vCPU, 4GB RAM, 80GB SSD
- ~Rp. 200.000–350.000/month on IDCloudHost

---

## 11. Implementation Roadmap

### Phase 1 — Core Protocol (Month 1–2)
- [ ] Go project scaffold (Gin + sqlc + PostgreSQL)
- [ ] WebSocket server on port 4747
- [ ] Noise_XX handshake implementation
- [ ] JWT + Redis session system
- [ ] User registration + Ed25519 key upload
- [ ] X3DH pre-key bundle upload/fetch
- [ ] 1-to-1 encrypted message send/receive
- [ ] Twitter Snowflake ID generator
- [ ] Rate limiter middleware (Redis)
- [ ] PostgreSQL schema + migrations

### Phase 2 — Features (Month 2–4)
- [ ] Group chat (Sender Keys)
- [ ] Invite link system (expiry + max use + revoke)
- [ ] File upload (2MB enforced, local storage)
- [ ] Disappearing messages (TTL)
- [ ] Read receipts + typing indicators
- [ ] Store & forward (offline delivery queue)
- [ ] 12-word BIP-39 account recovery
- [ ] Web Push (VAPID + Service Worker)
- [ ] WebRTC call signaling (SDP/ICE relay)

### Phase 3 — Web Client (Month 3–5)
- [ ] React + TypeScript + Vite scaffold
- [ ] libsodium-wrappers integration
- [ ] IndexedDB key storage (encrypted)
- [ ] WebSocket connection + IMCP framing
- [ ] 1-to-1 chat UI
- [ ] Group chat UI
- [ ] File/image preview
- [ ] WebRTC call UI (audio + video)
- [ ] TOFU trust flow + key change warning UI
- [ ] Service Worker + Web Push
- [ ] Freemium gate UI

### Phase 4 — Commercial Launch (Month 5–7)
- [ ] QR payment flow (manual admin confirm)
- [ ] Premium tier enforcement
- [ ] 2-hop onion routing (premium)
- [ ] Prometheus + Grafana dashboards
- [ ] IDCloudHost VPS deployment
- [ ] Nginx + Certbot TLS setup
- [ ] Beta: first 100 users (free 3 months)
- [ ] PCT patent filing preparation
- [ ] PDP Law compliance review

### Phase 5 — Scale (Month 7+)
- [ ] Xendit payment integration
- [ ] Flutter mobile client (Android + iOS)
- [ ] Group calls (WebRTC conference)
- [ ] Quantum-resistant crypto (Kyber KEM)
- [ ] Multi-server federation (optional)

---

## 12. Patent Candidates

> To be reviewed with a PCT patent attorney.

1. **Privacy-as-a-premium-tier** — 2-hop onion routing monetized as a freemium feature
2. **Uniform envelope padding + timestamp rounding** on WebSocket (not QUIC/TCP)
3. **12-word BIP-39 portable recovery including encrypted message history** (not just identity)
4. **Triple-constrained invite links** (expiry + max usage + admin-revocable) in E2E encrypted groups
5. **TOFU-first trust with inline upgrade path** — UX pattern for progressive security

---

*Document status: FINAL DRAFT v0.3 — Ready for implementation*
*App: GhenApp | Protocol: IMCP*
*Author: [Your Name] | Year: 2026*
*Classification: PROPRIETARY — DO NOT DISTRIBUTE*
