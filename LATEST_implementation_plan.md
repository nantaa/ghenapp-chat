# GhenApp Gap-Closure — Implementation Plan
> Derived from `ghenapp_gap_analysis.svg`  
> Date: 2026-05-12  
> Status: **Active — implementing**

---

## Gap Analysis Summary

| # | Feature / Component | SVG Status | Gap |
|---|---|---|---|
| 1 | WebSocket server (Gin + gorilla/ws) | ✅ Done | — |
| 2 | Noise_XX_25519_ChaChaPoly handshake | ✅ Done | — |
| 3 | Ping/pong heartbeat (30s) | ✅ Done | — |
| 4 | Exponential backoff reconnect | ✅ Done (client-side) | — |
| 5 | **BLAKE2s hashing** | ❌ Missing | Using SHA-256 instead |
| 6 | **FlatBuffers wire format** | 🟡 Partial | Custom binary, not FlatBuffers |
| 7 | **Uniform envelope padding** | ❌ Missing | Not implemented |
| 8 | **Timestamp rounding (anti-analysis)** | ❌ Missing | Not implemented |
| 9 | X3DH key exchange (1-to-1) | ✅ Done | — |
| 10 | Double Ratchet (1-to-1) | ✅ Done | — |
| 11 | **Sender Keys (group E2E)** | 🟡 Partial | DB schema only, no client logic |
| 12 | **BIP-39 mnemonic (12-word recovery)** | 🟡 Partial | Simplified wordlist, not real BIP-39 |
| 13 | **IndexedDB key storage (AES-256-GCM)** | 🟡 Partial | No passphrase encryption |
| 14 | **TOFU / key change warning** | ❌ Missing | Not implemented |
| 15 | 1-to-1 DM (create + message) | ✅ Done | — |
| 16 | **Group chat (send/receive)** | 🟡 Partial | Server done, client UI missing |
| 17 | **Disappearing messages (TTL)** | 🟡 Partial | Server purge only, no UI |
| 18 | **Typing indicators / read receipts** | ❌ Missing | Not implemented |
| 19 | **WebRTC call signaling** | ❌ Missing | Not implemented |
| 20 | **2-hop onion routing (premium)** | ❌ Missing | Not implemented |
| 21 | **Payment / premium tier enforcement** | 🟡 Partial | DB schema only, no flow |
| 22 | Web Push notifications | ✅ Done (VAPID) | — |
| 23 | File upload (2MB) | ✅ Done | — |

---

## Strategy: 4 Waves in Priority Order

Prioritization logic:
- **Security gaps first** — broken crypto is a blocker for real users
- **UX completeness second** — things that make the app feel broken (typing, read receipts, group UI)
- **Protocol compliance third** — BLAKE2s, padding, FlatBuffers are important but non-breaking for now
- **Deferred** — WebRTC, onion routing, payments are Phase 4+ in original roadmap

---

## Wave 1 — Crypto Hardening (IMMEDIATE) 🔐

> Goal: close security gaps before any real-user testing

### 1A — Passphrase-Encrypted IndexedDB Keys

**Gap:** Keys stored raw. Spec says AES-256-GCM encrypted with passphrase-derived key.

#### [MODIFY] [keygen.ts](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/crypto/keygen.ts)
- Add `encryptKey(passphrase, privateKey)` → AES-256-GCM via WebCrypto `PBKDF2` (100k iterations, SHA-256 salt)
- Add `decryptKey(passphrase, encryptedBlob)` → inverse
- Change `storePrivateKey` to always encrypt before storing
- Change `loadPrivateKey` to decrypt on load (takes passphrase param)
- Add `hasPassphrase(username)` to check if stored blob is encrypted

#### [MODIFY] [RegisterPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/RegisterPage.tsx)
- Add passphrase field to registration form (with strength indicator)
- Pass passphrase into `storePrivateKey`

#### [MODIFY] [LoginPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/LoginPage.tsx)
- Add passphrase field after entering username
- Validate by attempting decryption before proceeding

### 1B — Real BIP-39 Wordlist

**Gap:** Only 128-word stub list. Spec says 12-word BIP-39 phrase.

#### [MODIFY] [keygen.ts](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/crypto/keygen.ts)
- Replace `WORDLIST_SAMPLE` (128 words) with the full 2048-word BIP-39 English wordlist (import as static JSON or inline constant)
- `deriveMnemonic` already fixed (24-byte hash, non-overlapping pairs) — just swap wordlist
- Add `mnemonicToSeed(words: string[])` → reverses derivation for account recovery import

#### [NEW] [RecoveryPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/RecoveryPage.tsx)
- 12-word mnemonic input form for account recovery
- Derives private key from mnemonic, re-registers public key to server

### 1C — TOFU / Key Change Warning

**Gap:** Not implemented at all.

#### [NEW] [keygen.ts](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/crypto/keygen.ts) additions
- `storeTrustedKey(username, pubKeyHex)` → IDB
- `loadTrustedKey(username)` → IDB
- `checkKeyChange(username, newPubKeyHex)` → returns `'new' | 'same' | 'changed'`

#### [MODIFY] [session.ts](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/crypto/session.ts)
- After `initiateSession` resolves prekeys: call `checkKeyChange`, if `'changed'` → throw a typed `KeyChangedError` instead of proceeding

#### [MODIFY] [ChatPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/ChatPage.tsx)
- Catch `KeyChangedError` → show modal "⚠️ [user]'s encryption key changed. Verify in person before continuing." with Accept / Block options

---

## Wave 2 — Chat Feature Completeness (HIGH) 💬

> Goal: make the app feel complete for daily use

### 2A — Typing Indicators

**Gap:** Not implemented on client or server.

#### Backend
#### [MODIFY] [frame.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/frame.go)
- Add `TypeTyping = 0x10` and `TypeTypingStop = 0x11` frame type constants
- Frame payload: `[type 1B][conv_id 16B UUID]` — minimal, no message content

#### [MODIFY] [handler.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/handler.go)
- Handle `0x10`/`0x11`: relay frame to all other participants of the conversation via Hub (no DB write)

#### Frontend
#### [NEW] `src/ws/typingIndicator.ts`
- `sendTypingStart(conversationId)` — debounced, sends `0x10` frame
- `sendTypingStop(conversationId)` — sends `0x11` frame
- `onTypingFrame(cb)` — callback for incoming typing frames

#### [MODIFY] [ChatPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/ChatPage.tsx)
- Input onChange → `sendTypingStart`, onBlur/timeout → `sendTypingStop`
- Display "Alice is typing…" bubble when `0x10` received (auto-clears after 5s or on `0x11`)

### 2B — Read Receipts

**Gap:** Not implemented.

#### Backend
#### [MODIFY] [frame.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/frame.go)
- Add `TypeReceipt = 0x12` frame type
- Payload: `[type 1B][msg_id 8B snowflake]`

#### [MODIFY] [router.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/message/router.go)
- Handle `0x12`: write `delivered_at` to messages table, relay receipt frame to sender

#### DB
#### [MODIFY] migration
- Add `delivered_at TIMESTAMPTZ` and `read_at TIMESTAMPTZ` columns to `messages` table

#### Frontend
#### [MODIFY] [ChatPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/ChatPage.tsx)
- On message display (IntersectionObserver): send `0x12` receipt for visible messages
- Show tick icons on sent messages: `·` sending → `✓` delivered → `✓✓` read

### 2C — Group Chat Client UI

**Gap:** Server is done, client has no group UI.

#### [MODIFY] [ChatPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/ChatPage.tsx)
- Add "New Group" button in conversation sidebar
- Group create modal: name + member picker (username search)
- Group conversation view: show sender name above each message bubble
- Member list drawer (click group name → opens)

#### [NEW] `src/crypto/senderKeys.ts`
- `generateSenderKey()` → X25519 keypair
- `encryptForGroup(plaintext, senderKey)` → ChaCha20-Poly1305
- `decryptFromGroup(ciphertext, senderKey)` → plaintext
- `distributeSenderKey(groupId, members, mySenderKey)` → X3DH-encrypt senderKey to each member

### 2D — Disappearing Messages UI

**Gap:** Server purges by TTL, client has no way to set or display TTL.

#### [MODIFY] [ChatPage.tsx](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp-web/src/pages/ChatPage.tsx)
- Timer icon in chat header → dropdown: Off / 1 min / 1 hr / 24 hr / 7 days
- Selected TTL stored in conversation metadata (IDB)
- TTL value embedded in message payload header when sending
- Messages with TTL show a countdown badge; client-side expiry also deletes from local IDB

---

## Wave 3 — Protocol Compliance (MEDIUM) 📡

> Goal: align wire-level behavior with the IMCP spec

### 3A — Switch Hashing to BLAKE2s (server)

**Gap:** Server uses SHA-256; spec mandates BLAKE2s.

#### [MODIFY] [noise.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/noise.go)
- Replace `crypto/sha256` hash function with `golang.org/x/crypto/blake2s`
- Update Noise handshake hash function constant from `"SHA256"` to `"BLAKE2s"`

> Note: `golang.org/x/crypto` already in go.mod. BLAKE2s is `blake2s.New256()`.

### 3B — Uniform Envelope Padding (server)

**Gap:** Not implemented. Anti-traffic-analysis patent candidate.

#### [MODIFY] [frame.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/frame.go)
- Add `PadToNearest(data []byte, blockSize int) []byte` — pads to next multiple of `blockSize` (256 bytes)
- Add `StripPadding(data []byte) []byte` — reads 2-byte pad-length trailer, strips

#### [MODIFY] [handler.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/ws/handler.go)
- Before writing outbound frame to WebSocket: `PadToNearest(frame, 256)`
- After reading inbound frame: `StripPadding(frame)`

### 3C — Timestamp Rounding (server)

**Gap:** Not implemented. Spec says round to nearest second.

#### [MODIFY] [router.go](file:///d:/Document%20Backup/app-build/GhenApp%20-%20Chat/ghenapp/internal/message/router.go)
- When writing `sent_at` / `created_at` to DB: `time.Unix(t.Unix(), 0)` (zero nanoseconds)
- When embedding timestamp in outbound frame: same truncation

### 3D — FlatBuffers Wire Format (deferred — see note)

> [!NOTE]
> The custom binary format is already stable and working. Migrating to FlatBuffers is a significant refactor of both client and server with no user-visible benefit at this stage. **Deferred to after beta launch.** The current format should be documented as `IMCP-Binary-v1` in the protocol spec as a deliberate interim format.

---

## Wave 4 — Deferred (Post-Beta) 🚀

| Item | Reason for deferral |
|---|---|
| WebRTC call signaling | No call UI exists yet; signaling alone is not testable |
| 2-hop onion routing | Premium feature; requires relay infrastructure |
| Payment / premium tier enforcement | MVP needs free users first |
| FlatBuffers migration | Stable working format in place; migration risk outweighs benefit |

---

## Proposed Changes — File Map

### Frontend `ghenapp-web/src/`

| File | Change |
|---|---|
| `crypto/keygen.ts` | AES-256-GCM passphrase encryption, full BIP-39 wordlist, TOFU key storage |
| `crypto/session.ts` | TOFU check on session init, `KeyChangedError` |
| `crypto/senderKeys.ts` | **[NEW]** Group Sender Keys encrypt/decrypt |
| `ws/typingIndicator.ts` | **[NEW]** Typing indicator send/receive helpers |
| `pages/ChatPage.tsx` | Typing UI, read receipts, group UI, disappearing messages UI, TOFU warning modal |
| `pages/LoginPage.tsx` | Passphrase field |
| `pages/RegisterPage.tsx` | Passphrase field + strength meter |
| `pages/RecoveryPage.tsx` | **[NEW]** 12-word mnemonic account recovery |

### Backend `ghenapp/`

| File | Change |
|---|---|
| `internal/ws/frame.go` | Typing/receipt frame types, envelope padding helpers |
| `internal/ws/handler.go` | Relay typing frames, apply padding on send/recv |
| `internal/ws/noise.go` | SHA-256 → BLAKE2s |
| `internal/message/router.go` | Handle receipts, timestamp rounding |
| `db/migrations/` | Add `delivered_at`, `read_at` to messages |

---

## Execution Order

```
Wave 1A (passphrase IDB) → Wave 1B (BIP-39 wordlist) → Wave 1C (TOFU)
     ↓
Wave 2A (typing indicators) → Wave 2B (read receipts) → Wave 2C (group UI) → Wave 2D (disappearing UI)
     ↓
Wave 3A (BLAKE2s) → Wave 3B (padding) → Wave 3C (timestamp rounding)
```

---

## Verification Plan

- **Wave 1A**: Register with passphrase → reload → login requires same passphrase → wrong passphrase shows error
- **Wave 1B**: Registration shows 12-word phrase → recovery flow restores correct private key
- **Wave 1C**: Simulate key change by clearing IDB and re-registering → warning modal appears
- **Wave 2A**: Two browser tabs → typing in one shows indicator in other
- **Wave 2B**: Read message → sender sees double-tick
- **Wave 2C**: Create group → members receive messages → sender name shown
- **Wave 3A**: `go test ./internal/ws/...` — noise handshake tests pass with BLAKE2s
- **Wave 3B**: Wireshark/WS inspector — all frames are multiples of 256 bytes
