# GhenApp Gap-Closure — Task Tracker

## Wave 1 — Crypto Hardening 🔐

- [x] **1A** — Passphrase-encrypted IndexedDB keys (keygen.ts, LoginPage.tsx, RegisterPage.tsx)
- [x] **1B** — Full BIP-39 wordlist + mnemonicToSeed (keygen.ts, RecoveryPage.tsx)
- [x] **1C** — TOFU / key change warning (keygen.ts, session.ts, ChatPage.tsx)

## Wave 2 — Chat Feature Completeness 💬

- [x] **2A** — Typing indicators (frame.go handler, src/ws/typingIndicator.ts, ChatPage.tsx)
- [x] **2B** — Read receipts (router.go, DB migration 006, ChatPage.tsx)
- [x] **2C** — Group chat client UI (ChatPage.tsx, src/crypto/senderKeys.ts)
- [ ] **2D** — Disappearing messages UI (ChatPage.tsx)

## Wave 3 — Protocol Compliance 📡

- [ ] **3A** — BLAKE2s hashing in noise.go
- [x] **3B** — Uniform envelope padding — ALREADY DONE (frame.go)
- [x] **3C** — Timestamp rounding — ALREADY DONE (frame.go)
