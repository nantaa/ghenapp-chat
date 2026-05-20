# IMCP / GhenApp — AI Handover Document
> Purpose: Full context briefing for a new AI to continue this project
> Status: Active development — prototype running at ghen-app.my.id
> Last updated: 2026-05 (updated from pre-implementation to reflect actual codebase state)
> Classification: PROPRIETARY

---

## 1. Who You Are Talking To

- Solo developer/founder based in Indonesia
- Building a commercial chat application called **GhenApp**
- Backed by a proprietary protocol called **IndoMade Chat Protocol (IMCP)**
- Plans to expand team after prototype is built
- Intends to file a PCT international patent
- Non-technical in some areas — explain things clearly but don't oversimplify
- Highly visionary — responds well to ambitious ideas grounded in reality

---

## 2. Project Identity

| Property | Value |
|---|---|
| Protocol name | IndoMade Chat Protocol (IMCP) |
| App name | **GhenApp** |
| Spec version | v0.3 (canonical spec) |
| Code stage | Prototype live — Phase 1 complete, Phase 2 partial |
| Live URL | https://ghen-app.my.id |
| Type | Proprietary commercial messaging protocol + app |
| Primary goal | Speed-first, E2E encrypted chat |
| Market | Indonesia (primary), international (later) |
| Business model | Freemium — Rp. 25.000/month premium |
| Legal entity | Personal (sole proprietor for now) |
| Jurisdiction | Indonesia — PDP Law compliant |
| Patent plan | PCT international filing — attorney not yet hired |
| VPS | IDCloudHost |
| Server port | **4747** (spec) — currently running on **8080** (must fix before launch) |
| Domain | ghen-app.my.id (live, TLS active) |

---

## 3. Complete Technical Stack (All Decided — Do Not Re-ask)

### Backend
| Component | Decision |
|---|---|
| Language | Go |
| Framework | Gin |
| Query layer | sqlc (type-safe SQL, no ORM) |
| Database | PostgreSQL |
| Cache / broker | Redis (Pub/Sub + rate limiting + sessions) |
| File storage | Local VPS disk |
| ID generation | Twitter Snowflake (64-bit) |
| Session system | JWT (15min) + opaque refresh token in Redis (30 days) |
| Reverse proxy | Nginx |
| TLS | Let's Encrypt / Certbot |
| Monitoring | Prometheus + Grafana |

### Protocol
| Component | Decision | Code status |
|---|---|---|
| Transport | WebSocket (wss://) primary, ws:// auto fallback | wss running, no silent fallback yet |
| Port | 4747 | Currently 8080 — must fix |
| Encryption (1-to-1) | X3DH key exchange + Double Ratchet | ✅ Done |
| Encryption (groups) | Sender Keys (Signal-style) | Server done, client missing |
| Transport security | Noise_XX_25519_ChaChaPoly_**BLAKE2s** | Done but uses SHA-256 not BLAKE2s |
| Wire format | FlatBuffers (binary) | Custom binary used instead |
| Calls | WebRTC (browser-native, SDP/ICE relay via server) | Not started |
| Push notifications | Web Push API + Service Worker (VAPID) | ✅ Done |
| Onion routing | 2-hop (premium tier only) | Not started |
| Message retention | Auto-delete after 3 years | ✅ Done (cron) |
| File size cap | 2MB (enforced server-side) | ✅ Done |
| Max group size | 100 members | DB schema enforced |

### Cryptographic Primitives
| Purpose | Algorithm | Code status |
|---|---|---|
| Key exchange | X25519 (RFC 7748) | ✅ Done |
| Signatures | Ed25519 (RFC 8032) | ✅ Done |
| Symmetric encryption | ChaCha20-Poly1305 (RFC 8439) | ✅ Done |
| Hashing | BLAKE2s (RFC 7693) | ⚠️ SHA-256 used instead — spec deviation |
| KDF | HKDF (RFC 5869) | ✅ Done (BLAKE2b-based in client) |
| Randomness | OS CSPRNG | ✅ Done |
| Recovery phrase | BIP-39 (12 words) | ⚠️ Fake 128-word list, broken derivation |
| Quantum resistance | Deferred to future version | Deferred |

### Client (v1)
| Component | Decision | Code status |
|---|---|---|
| Platform | Web browser (primary) | ✅ Live |
| Framework | React 19 + TypeScript | ✅ Done (upgraded to React 19) |
| Build tool | Vite 8 | ✅ Done |
| Styling | TailwindCSS | ⚠️ Using plain CSS instead — not Tailwind |
| State | Zustand | ✅ Done |
| Crypto | libsodium-wrappers + WebCrypto API | ✅ Done |
| Key storage | IndexedDB (AES-256 encrypted) | ⚠️ IndexedDB done, AES-256 encryption missing |
| Binary encoding | flatbuffers npm package | ⚠️ Package installed, not used |

### Future Clients
- v2: Flutter mobile (Android + iOS)
- v3: Flutter desktop

---

## 4. Protocol Design Decisions (All Locked)

### Transport
- WebSocket chosen over QUIC for universal browser compatibility
- Auto fallback: wss:// → ws:// (silent, no user action) — **not yet implemented**
- Heartbeat: ping/pong every 30 seconds — ✅ done
- Reconnect: exponential backoff (1s → 2s → 4s → max 30s) — ✅ done

### Routing
- Centralized only — no P2P, no federation
- Three modes: Online Relay / Store & Forward / 2-Hop Onion (premium)
- Envelope padding to uniform size (anti traffic-analysis) — **field exists, never filled**
- Timestamps rounded to nearest second — **not implemented, raw ms sent**

### Identity
- Identity = Username (3–32 chars) + Ed25519 keypair
- No phone number required
- Trust model: TOFU by default, optional QR/safety number upgrade — **not implemented**
- Key change policy: warn contact + block until re-verified — **not implemented**
- Recovery: 12-word BIP-39 phrase restores identity + message history — **partially implemented, history restore missing**
- Identity is portable across IMCP-compatible servers
- Users are searchable by username (optional hidden mode) — ✅ done

### Groups
- Sender Keys encryption (Signal-style) — **server done, client missing**
- Admin-only member management — ✅ done
- Invite links: expiry time + max usage count + admin-revocable — ✅ done
- New members: NO history access (secure default)
- Future v2: encrypted history re-share (optional)

### Sessions
- JWT access token: 15 minutes — ✅ done
- Opaque refresh token: 30 days, stored in Redis — ✅ done
- Logout = delete refresh token from Redis (instant revoke) — ✅ done

### Message History on New Device (Design Decision Pending)
The spec says BIP-39 recovery restores "identity + message history." This is architecturally undefined. Three options were discussed:

- **Option 1 (Signal-style):** Show greyed italic "You sent a message" — honest, no cloud, pure forward secrecy
- **Option 2 (Placeholder):** Show `[Sent message]` in grey text
- **Option 3 (WhatsApp-style):** Server-side encrypted history log, decryption key derived from BIP-39 seed

**Current code behavior:** Shows 🔒 encrypted message — looks broken, not intentional. **This decision must be made before beta launch.**

If Option 3 is chosen, the architecture change is:
- Every message encrypted under both the ratchet key (delivery) AND a per-conversation history key
- History key derived deterministically from BIP-39 seed (so restore = automatic)
- Server stores opaque history blobs (cannot read them — "server never decrypts" principle preserved)
- This is the most elegant IMCP-native design and supports patent candidate #3

### Payments
- v1: QR code manual (admin confirms payment) — **DB schema only, no flow**
- v2: Xendit integration — not started
- Price: Rp. 25.000/month
- Launch promo: free 3 months for first 100 users
- Payment records stored in PostgreSQL — ✅ schema done

---

## 5. Freemium Feature Matrix

| Feature | Free | Premium | Code status |
|---|---|---|---|
| 1-to-1 messaging | ✅ | ✅ | ✅ Done |
| Group chat (max 100) | ✅ | ✅ | Server done, no client UI |
| File/image/video (2MB) | ✅ | ✅ | Server done, no UI in chat |
| Voice/video calls (basic) | ✅ | ✅ | Not started |
| Disappearing messages | ✅ | ✅ | Server cron done, no TTL UI |
| Read receipts | ✅ | ✅ | Not started |
| Typing indicators | ✅ | ✅ | Not started |
| Web Push notifications | ✅ | ✅ | ✅ Done |
| 2-hop onion privacy mode | ❌ | ✅ | Not started |
| HD voice/video calls | ❌ | ✅ | Not started |
| Custom themes | ❌ | ✅ | Not started |
| Priority message delivery | ❌ | ✅ | Not started |
| Extended message backup | ❌ | ✅ | Not started |
| Larger groups (100+) | ❌ | ✅ future | Not started |

---

## 6. Spec vs Code — Full Gap Table

This section is the authoritative gap analysis between the locked spec (v0.3) and the actual codebase as of 2026-05.

### ✅ Fully implemented
- X3DH key exchange (1-to-1)
- Double Ratchet (1-to-1)
- Noise_XX handshake (with SHA-256 deviation — see below)
- JWT + Redis session system
- User registration + Ed25519 key upload
- X3DH pre-key bundle upload/fetch
- Snowflake ID generation
- Rate limiter middleware (Redis)
- PostgreSQL schema + migrations (all 5 migrations)
- Store & forward offline delivery (Redis pub/sub + DB queue)
- Web Push VAPID notifications + service worker
- File upload 2MB (server-side enforcement)
- Ping/pong heartbeat (30s)
- Exponential backoff reconnect (client)
- Rate limiting (free + premium tiers)
- Group CRUD + invite links (server)
- User search by username

### ⚠️ Partial — started but incomplete
| Item | What's done | What's missing |
|---|---|---|
| Sender Keys (group E2E) | DB schema, server API endpoints | Entire client implementation |
| BIP-39 recovery | 12-word UI at register | Real BIP-39 wordlist (2048 words), correct entropy→checksum→index math, history restore |
| IndexedDB key storage | Keys stored in IndexedDB | AES-256-GCM passphrase encryption wrapper |
| Disappearing messages | Server auto-purge cron | UI to set TTL on a message |
| FlatBuffers wire format | Package installed in package.json | Actual usage — custom binary used instead |
| wss:// transport | TLS running at ghen-app.my.id | Silent ws:// fallback, CSP headers in Nginx config |
| File sharing in chat | Server upload/serve endpoints | File-send button in chat UI |
| Group chat client | Server-side complete | Group chat UI in ChatPage, group session key distribution |

### ✗ Not started
| Item | Spec section | Priority before beta |
|---|---|---|
| TOFU trust + key change warning | §4 Identity | HIGH — security promise |
| Read receipts | §5 Feature matrix | HIGH — free tier promise |
| Typing indicators | §5 Feature matrix | HIGH — free tier promise |
| WebRTC call signaling + UI | §3 Protocol | HIGH — free tier promise |
| New-device message UX (option 1/2/3) | §4 Identity | HIGH — visible bug now |
| Content Security Policy headers (Nginx) | §3 Infrastructure | HIGH — DevTools errors now |
| 2-hop onion routing | §3 Protocol | LOW — premium, Phase 4 |
| Payment QR flow | §4 Payments | MEDIUM — needed at launch |
| Prometheus + Grafana | §6 Roadmap Phase 4 | LOW — Phase 4 |
| ML layer (ACE, PTE, BKG, SPM, FAD, IPS, NCE) | §8 ML inventions | LOW — post-launch |

### 🔧 Spec deviations (code differs from spec — must fix before patent filing)
| Spec says | Code does | Fix needed |
|---|---|---|
| Port 4747 | Port 8080 | Change `PORT` default in config.go + Nginx proxy |
| BLAKE2s hashing | SHA-256 | Replace `crypto/sha256` + `hmac/sha256` in noise.go with golang.org/x/crypto/blake2s |
| FlatBuffers wire format | Custom binary | Either adopt flatbuffers or update spec to reflect custom format |
| Uniform envelope padding | Never filled | Fill `Padding` field with random bytes in encodeFrame (client) + server Encode() |
| Timestamps rounded to nearest second | Raw milliseconds | Round in encodeFrame: `(time.Now().UnixMilli() / 1000) * 1000` |
| IndexedDB AES-256-GCM encrypted | Raw bytes | Add passphrase-derived AES-256-GCM wrap in keygen.ts storePrivateKey |
| TailwindCSS styling | Plain CSS (index.css) | Either migrate to Tailwind or update spec |
| wss:// silent fallback | No fallback | Add try/catch in GhenWSClient._connect() |

---

## 7. Implementation Roadmap (Updated)

### Phase 1 — Core Protocol ✅ COMPLETE
- [x] Go project scaffold (Gin + sqlc + PostgreSQL)
- [x] WebSocket server (on 8080, not 4747 yet)
- [x] Noise_XX handshake (SHA-256 variant)
- [x] JWT + Redis session system
- [x] User registration + Ed25519 key upload
- [x] X3DH pre-key bundle upload/fetch
- [x] 1-to-1 encrypted message send/receive
- [x] Twitter Snowflake ID generator
- [x] Rate limiter middleware (Redis)
- [x] PostgreSQL schema + migrations

### Phase 2 — Features (IN PROGRESS)
- [x] Group chat server (Sender Keys schema + API)
- [x] Invite link system
- [x] File upload (2MB, local storage)
- [x] Disappearing messages (server TTL purge)
- [x] Store & forward (offline delivery)
- [x] Web Push (VAPID + Service Worker)
- [ ] **Group chat client UI** ← next priority
- [ ] **Read receipts + typing indicators** ← free tier promise
- [ ] **12-word BIP-39 real implementation** ← user data safety
- [ ] WebRTC call signaling
- [ ] TOFU trust flow + key change warning

### Phase 3 — Web Client Polish (IN PROGRESS)
- [x] React + TypeScript + Vite scaffold
- [x] libsodium-wrappers crypto integration
- [x] IndexedDB key storage (unencrypted)
- [x] Full 1-to-1 chat UI
- [x] WebRTC CALL_SIGNAL frame type (no UI yet)
- [x] Web Push integration
- [ ] **IndexedDB AES-256-GCM passphrase encryption**
- [ ] **New-device message UX (decision needed)**
- [ ] **CSP headers in Nginx**
- [ ] WebRTC call UI
- [ ] TOFU trust UI + key change warning modal
- [ ] Freemium gate UI
- [ ] File-send button in chat
- [ ] TTL setting UI in chat

### Phase 3.5 — Spec Corrections (Before Patent Filing)
These must be fixed to match the spec before any patent filing:
- [ ] Port 4747 (change from 8080)
- [ ] BLAKE2s (replace SHA-256 in noise.go)
- [ ] Real FlatBuffers OR update spec to reflect custom binary
- [ ] Uniform envelope padding (fill random bytes)
- [ ] Timestamp rounding (nearest second)
- [ ] wss:// silent fallback
- [ ] IndexedDB AES-256-GCM

### Phase 4 — Launch (Month 5–7)
- [ ] QR payment flow
- [ ] Premium tier enforcement
- [ ] 2-hop onion routing (premium)
- [ ] Prometheus + Grafana dashboards
- [ ] IDCloudHost VPS final deployment
- [ ] Port 4747
- [ ] Nginx CSP headers
- [ ] Beta: first 100 users
- [ ] PCT patent filing preparation
- [ ] PDP Law compliance review

### Phase 5 — Scale (Month 7+)
- [ ] Xendit payment integration
- [ ] Flutter mobile client
- [ ] Group calls (WebRTC conference)
- [ ] Quantum-resistant crypto (Kyber KEM)
- [ ] ML layer implementation (start with SPM + BKG)

---

## 8. Patent Candidates (Identified So Far)

These are novel elements identified for PCT filing:

### From Protocol Design
1. **Tiered privacy as protocol primitive** — 2-hop onion routing monetized as freemium, privacy level encoded as wire-level field
2. **Uniform envelope padding + timestamp rounding** on WebSocket transport
3. **12-word BIP-39 portable recovery including encrypted message history** — if Option 3 history design is chosen, derived from identity seed deterministically. Most elegant + strongest patent position.
4. **Triple-constrained invite links** (expiry + max usage + revocable) in E2E encrypted groups — ✅ already implemented
5. **TOFU-first trust with inline upgrade path** — UX pattern for progressive security

### From ML Layer (Proposed — Not Yet in Spec or Code)
6. **Adaptive Compression Engine (ACE)** — on-device personalized compression dictionary, trained on user's own patterns, negotiated at session level
7. **Predictive Traffic Engine (PTE)** — ML predicts network degradation, pre-fetches messages at protocol transport layer
8. **Federated Abuse Detection (FAD)** — federated learning for spam detection inside E2E encrypted protocol (server never sees content)
9. **Behavioral Key Guard (BKG)** — behavioral biometrics as cryptographic session gate at protocol layer, affects key ratchet advancement
10. **Smart Pre-Key Manager (SPM)** — ML-predicted X3DH pre-key generation and upload scheduling
11. **ML Onion Path Selection (IPS)** — ML-optimized relay node selection for 2-hop onion routing
12. **Neural Compression-Encryption (NCE)** — encryption performed in neural codec latent space (research-level, highest novelty)

### From Hardware (Proposed — Not Yet in Spec)
13. **IMCP Relay Node** — dedicated hardware relay box for offline mesh
14. **IMCP Key Card** — hardware security key (secure element chip) for Ed25519 key storage
15. **GhenBox** — LoRa mesh relay device for offline coverage (Indonesia-specific)
16. **Dead Drop Puck** — NFC air-gapped E2E encrypted message exchange device

---

## 9. Novel Inventions Discussed (ML Layer)

The conversation evolved to explore ML embedded INTO the protocol layer (not just as app features). Key distinction: **ML as protocol primitive, not app feature.**

None of these are in the code yet. All are architecturally defined but not formally added to the spec document.

### Inventions Ready to Add to Spec:

**ACE — Adaptive Compression Engine**
- On-device ML trains on user's own message patterns
- Builds personal compression dictionary (never leaves device)
- Dictionary negotiated during WebSocket session handshake
- Achieves ~75% compression vs ~40% standard zstd
- Status: Architecturally defined, needs formal spec

**PTE — Predictive Traffic Engine**
- ML predicts network degradation from location/time patterns
- Pre-fetches messages before entering bad network area
- Pre-loads encryption keys for predicted contacts
- Operates at transport layer — not app layer
- Status: Architecturally defined, needs formal spec

**BKG — Behavioral Key Guard**
- Trains silently on typing rhythm, scroll behavior, composition patterns
- Runs before message decryption as protocol-level gate
- Anomaly → stops ratchet key advancement → requires re-auth
- Runs in browser via ONNX.js (client-side, private)
- Status: Architecturally defined, needs formal spec

**SPM — Smart Pre-Key Manager**
- Predicts pre-key consumption rate from usage patterns
- Pre-generates and uploads keys before running out
- Runs on server (Go + ONNX runtime)
- Status: Architecturally defined, needs formal spec

**FAD — Federated Abuse Detection**
- Each client trains local model on own messages
- Sends only gradient updates to server (not content)
- Server aggregates via FedAvg
- Requires user base — implement after beta launch
- Status: Architecturally defined, needs formal spec

**IPS — Intelligent Path Selection**
- ML selects onion relay nodes for speed + privacy
- Avoids correlated node ownership
- Maximizes geographic diversity
- Status: Architecturally defined, needs formal spec

**NCE — Neural Compression-Encryption (Research)**
- Encryption performed in neural codec latent space
- Most novel — bridges neural compression + crypto protocols
- 6-12 months research work
- Potential academic paper + strongest patent
- Status: Concept only, needs research design

---

## 10. Hardware Ideas Discussed

The following hardware devices were proposed as part of the GhenApp ecosystem. None are in the spec yet.

**GhenBox** (highest priority for Indonesia)
- LoRa 915MHz + WiFi + Bluetooth mesh relay
- Raspberry Pi Zero 2W or ESP32-S3 based
- Solar + battery powered
- Enables IMCP messaging without internet
- Target: villages, islands, remote areas, emergencies

**IMCP Key Card**
- Secure element chip (ATECC608B or similar)
- Stores Ed25519 private key — never exposes it
- Signs messages inside hardware
- NFC or USB-C interface
- Highest patent value for security

**Dead Drop Puck**
- Passive NFC chip (no battery)
- Air-gapped message exchange
- Server never involved
- Coin-sized

**IMCP Relay Node**
- Small box running stripped IMCP server
- For businesses — local relay when internet fails
- Plug-and-play

---

## 11. Documents Produced So Far

| File | Description | Status |
|---|---|---|
| `NCP_Protocol_Design.md` | Original draft (before renaming to IMCP) | Superseded |
| `NCP_Questions.md` | Original question list (50+ questions) | Answered |
| `IMCP_Protocol_Design_v0.2.md` | Second draft with most answers | Superseded |
| `IMCP_Remaining_Questions.md` | Remaining 15 questions after v0.2 | Answered |
| `IMCP_Protocol_Design_v0.3_FINAL.md` | **Current canonical spec** | ✅ Active |
| `GhenApp_Project_Kickoff.md` | Phase 1 build guide + commands | ✅ Active |
| `IMCP_AI_Handover.md` | Original handover document (pre-implementation) | Superseded |
| `IMCP_AI_Handover_v2.md` | **This document — reflects actual code state** | ✅ Active |
| `chatStore.ts` | Fixed IDB cache (no destructive wipe, hash cache) | ✅ Outputted |
| `ChatPage.tsx` | Fixed history load, sent-message cache before send | ✅ Outputted |

**Most important files for a new AI:**
1. `IMCP_Protocol_Design_v0.3_FINAL.md` — read this first (the target)
2. `IMCP_AI_Handover_v2.md` — this document (the current state)
3. `GhenApp_Project_Kickoff.md` — read this third (build commands)

---

## 12. Conversation History Summary

The discussion followed this arc:

1. Started with question about building backend using MTProto
2. Evolved to: can we build our own chat app using Telegram's API? → No, that ties you to Telegram
3. Pivoted to: should we use Matrix, or invent a new protocol?
4. Decision: invent a new protocol (IMCP)
5. Designed the full protocol stack together
6. Created design doc + question list
7. Answered all 50+ questions via uploaded text files
8. Named the app GhenApp, protocol IMCP
9. Locked all technical decisions (stack, crypto, features, pricing)
10. Explored what makes IMCP genuinely novel vs competitors
11. Explored hardware integration opportunities
12. Explored ML integration as protocol primitives (7 inventions identified)
13. Created first handover document
14. **Started Phase 1 coding — built working prototype**
15. **Diagnosed and fixed "🔒 encrypted message on reload" bug (IDB cache + ratchet architecture)**
16. **Compared spec vs codebase — identified all gaps (this document)**
17. **Discussed Signal vs WhatsApp history philosophy — pending decision on new-device UX**

---

## 13. Open Decisions (Must Resolve Before Beta)

These are unresolved design questions that block either development or patent filing:

### 1. New-device message history UX (BLOCKING — visible bug now)
When a user logs in on a new browser/device, their own sent messages are on the server as encrypted blobs but the plaintext cache is empty. Forward secrecy means own sent ciphertext cannot be re-decrypted.

**Options:**
- **Option 1 — Signal-style:** Greyed italic "You sent a message" — honest, no cloud, pure forward secrecy. Best fit for IMCP philosophy.
- **Option 2 — Placeholder:** `[Sent message]` in grey text
- **Option 3 — Server-side encrypted history log:** Derive a per-conversation history key from BIP-39 seed. Server stores opaque history blobs. Restore from mnemonic = full history. Strongest patent position (patent candidate #3). Most work.

**Recommendation:** Option 3 if you want WhatsApp-style UX and patent #3 strengthened. Option 1 if you want fastest path to beta.

### 2. FlatBuffers vs custom binary (BLOCKING for patent filing)
The spec says FlatBuffers. The code uses a custom binary format. You must either:
- Migrate to actual FlatBuffers (more work, spec-compliant)
- Update the spec to say "IMCP binary frame format" and define it formally (less work, still patentable)

**Recommendation:** Update the spec to formally define the custom binary format. It is simpler, already working, and a custom format is more distinctive for patent purposes than "we used FlatBuffers."

### 3. BLAKE2s vs SHA-256 in Noise handshake (BLOCKING for patent filing)
The spec says BLAKE2s. The code uses SHA-256. Both sides agree so the protocol works, but the patent spec will be wrong.

**Recommendation:** Fix the code to use BLAKE2s (`golang.org/x/crypto/blake2s` on server, `libsodium-wrappers` BLAKE2b as closest available on client). This is a small change with high importance for spec accuracy.

---

## 14. Immediate Next Steps (Where We Left Off)

**Last topic discussed:** Comparison of Signal vs WhatsApp message history philosophy, and how IMCP can support WhatsApp-style history using server-side encrypted history log derived from the BIP-39 seed — which also strengthens patent candidate #3.

**What was about to happen:** A decision on the new-device UX (Option 1/2/3 above).

**After that decision, recommended order:**
1. Implement chosen new-device UX (Option 1 is one day of work; Option 3 is one week)
2. Fix CSP headers in Nginx (fixes DevTools errors visible on ghen-app.my.id — one hour)
3. Group chat client UI (biggest missing free-tier feature)
4. Read receipts + typing indicators (free-tier promise)
5. Real BIP-39 implementation (user data safety)
6. BLAKE2s fix (spec accuracy)
7. Port 4747 (before any public announcement)
8. WebRTC calls (free-tier promise, complex)
9. TOFU + key change warning (security promise)

---

## 15. Personality & Communication Notes

- Founder thinks big — match their ambition while keeping things grounded
- They appreciate structured tables and clear comparisons
- They ask broad questions then narrow down — let them drive direction
- They respond well to "honest assessment" framing
- They are building this seriously — treat it as real commercial IP
- Don't re-ask questions that are already answered in this document
- Don't suggest using Telegram API or existing platforms — decision is final
- Don't suggest switching from Go, React, PostgreSQL — stack is locked
- Patent and IP are important to them — always flag novel elements

---

## 16. Key Principles to Never Violate

These are architectural decisions that are final and must not be revisited:

1. **No federation** — IMCP is centralized, one server, full control
2. **No P2P** — all messages route through IMCP server
3. **No custom cryptography** — only IETF-standardized primitives
4. **Server never decrypts** — server is a passthrough for encrypted blobs
5. **2MB file cap** — enforced server-side, non-negotiable
6. **WebSocket transport** — not QUIC, not raw TCP
7. **Go for backend** — not Node, not Python, not Rust
8. **React for web client** — not Vue, not Svelte
9. **PostgreSQL for storage** — not MongoDB, not MySQL
10. **Proprietary spec** — not open source, not published

---

*This document reflects the actual codebase state as of 2026-05.*
*A new AI reading this document should be able to continue without any repeated questions.*
*The gap table in §6 is the single most important section — read it before touching any code.*
*Classification: PROPRIETARY — DO NOT DISTRIBUTE*
