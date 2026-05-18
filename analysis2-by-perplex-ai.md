OK, now I have the full picture. Here's the complete investigation.

***

## Root cause: `acceptSession` being called on EVERY `0x02` frame — including history replay

The problem is NOT just in `ChatPage.tsx`. The real structural issue is deeper in `session.ts` itself. 

### The exact chain of events causing the spam

```
User opens chat → history loader runs → calls decryptInbound() for each old message
→ each old 0x02 frame triggers acceptSession() → saves a fresh ratchet state
→ ratchet state overwritten N times during history load
→ ratchet msgNum reset to 0 after every old message
→ live incoming message arrives at counter 0, but state now expects N
→ decrypt fails → deleteSession() called
→ next outbound message has no session → throws "No E2E session"
→ ChatPage catches it, user sees "[Message unavailable due to key change]" × N
```

Every message in history that has type `0x02` resets the ratchet from scratch. 

***

## What needs to be added: a **Session Version / Epoch** protocol

Your current design has **no way to distinguish** "this `0x02` is a fresh handshake I should accept" from "this `0x02` is an old historical message I already processed." Signal solves this by tracking **session epochs** — a monotonically increasing counter stored with the session state. Here's what needs to be added:

***

### Protocol Addition 1 — Session Epoch in ratchet state

Add `epoch` to `RatchetState`:

```ts
// ratchet.ts
export interface RatchetState {
  // ...existing fields
  epoch: number           // ← NEW: monotonic counter, incremented on every acceptSession
  ephemeralPubKey: Uint8Array  // ← NEW: store the EK of the handshake that created this epoch
}
```

In `initRatchetResponder`, set `epoch: 0` and store `ephemeralPubKey`. 

***

### Protocol Addition 2 — Idempotent `acceptSession` using epoch + EK dedup

In `session.ts`, `acceptSession` should **reject** a `0x02` frame if its ephemeral key matches the one already stored in the current session:

```ts
// session.ts — inside _decryptInboundInternal, before calling acceptSession
if (type === 0x02) {
  const existingSession = await loadSession(conversationId)
  
  // ── NEW: epoch/EK dedup check ────────────────────────────────────────
  // If we already have a session whose stored ephemeralPubKey matches
  // this frame's senderEphemeralPub, this is a REPLAY of the same
  // handshake we already accepted. Skip acceptSession, just decrypt
  // with existing state.
  if (
    existingSession?.ephemeralPubKey &&
    bytesEqual(existingSession.ephemeralPubKey, senderEphemeralPub)
  ) {
    // same session epoch — do NOT re-run acceptSession
  } else {
    // genuinely new handshake → accept and save new epoch
    await acceptSession(myUsername, senderIdentityPub, senderEphemeralPub,
      conversationId, opkPub !== undefined, opkPub)
  }
}
```

***

### Protocol Addition 3 — `decryptInboundStateless` for history loader (already stubbed, not wired)

`decryptInboundStateless` already exists in `session.ts`  but `ChatPage.tsx` history loader still calls `decryptInbound` (stateful). The history loader **must** use the stateless path:

```ts
// ChatPage.tsx — history loader, path 3
plain = (await decryptInboundStateless(rawPayload, user.username)) ?? undefined
```

BUT there's a gap: `decryptInboundStateless` only handles `0x02` frames (it returns `null` for `0x01`). Old `0x01` history frames from before the current ratchet epoch are simply unrecoverable — which is correct (forward secrecy), but the fallback should be graceful:

```ts
// ChatPage.tsx
if (plain == null && !isMine) {
  if (rawPayload[0] === 0x02) {
    plain = (await decryptInboundStateless(rawPayload, user.username)) ?? undefined
  }
  // 0x01 frames in history: unrecoverable without live ratchet state → show placeholder
  // Do NOT call decryptInbound here — it mutates ratchet state
}
```

***

### Protocol Addition 4 — Separate `historySession` store in IDB (optional but clean)

The deepest fix: keep two separate IDB stores — `ratchet` (live session, mutated only on live messages) and `ratchet-history` (ephemeral re-derived state used only for history decryption, never saved back). This is a proper architectural separation:

```ts
// ratchet.ts
export const SESSION_STORE = 'ratchet'
export const HISTORY_SESSION_STORE = 'ratchet-history'  // ← NEW, read-only snapshots
```

This mirrors how Signal's `SessionRecord` separates the *current session* from *archived sessions*. 

***

## Summary of changes needed

| # | Where | What | Why |
|---|---|---|---|
| 1 | `ratchet.ts` | Add `epoch` + `ephemeralPubKey` to `RatchetState` | Track which X3DH handshake created this session |
| 2 | `session.ts` | Dedup `acceptSession` by comparing stored `ephemeralPubKey` vs frame's EK | Prevents history `0x02` frames from resetting live ratchet |
| 3 | `ChatPage.tsx` | Replace `decryptInbound` → `decryptInboundStateless` in history loader | Stops history decrypt from advancing live ratchet counter |
| 4 | `ChatPage.tsx` | Remove `initiateSession` from sidebar click | Prevents responder side from constantly re-deriving sessions |
| 5 | `ratchet.ts` (optional) | Separate `ratchet-history` IDB store | Clean architectural separation like Signal's `SessionRecord` |