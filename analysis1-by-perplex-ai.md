Found it. The bug is in the **sidebar conversation click handler** AND the **history loader**. Both together cause the message spam you see in the screenshot.

***

## The two root causes

### 1. Sidebar click re-initiates session on EVERY click

```ts
onClick={async () => {
  setActiveConversation(conv.id)
  const existing = await loadSession(conv.id)
  if (!existing && user) {
    await initiateSession(user.username, otherUsername, conv.id)  // ← calls API
  }
}}
```

`initiateSession` calls `api.getPrekeys()` then `x3dhInitiate` and saves a new session. But `session.ts` has its own guard: `if (existing && !forceReset) return`. So this is harmless *unless* the session is missing — which it will be for the *responder* side (the peer who received the first message but never called `initiateSession`). On the responder side, `loadSession` returns null, so **every time they click the conversation, a brand new X3DH session is derived and saved**, overwriting the one the ratchet was using. The next decrypt fails, triggering self-heal, which creates yet another session, which the sender's next message can't decrypt, loop forever. 

### 2. History loader calls `decryptInbound` (stateful ratchet) on historical messages

```ts
plain = (await decryptInbound(rawPayload, m.conversation_id, user.username)) ?? undefined
```

`decryptInbound` uses the **live queued ratchet** — it advances `recvMsgNum` and saves state. Running it on 10+ old history messages on load advances the ratchet counter by 10+, so the next *live* message the peer sends arrives with counter `0` but the state expects counter `10+` → decrypt fails → self-heal → new session → spam. 

***

## The fix — push this directly

**Fix 1:** Remove the `initiateSession` call from the sidebar click. The responder side should never self-initiate; `decryptInbound`'s `acceptSession` path already handles that when the first message arrives.

**Fix 2:** Use `decryptInboundStateless` in the history loader instead of `decryptInbound`.

Here's the exact diff:

```ts
// sidebar onClick — REMOVE the initiateSession block entirely
onClick={() => setActiveConversation(conv.id)}
```

```ts
// history loader — change this line:
plain = (await decryptInbound(rawPayload, m.conversation_id, user.username)) ?? undefined

// to:
plain = (await decryptInboundStateless(rawPayload, user.username)) ?? undefined
```

And add the import:
```ts
import {
  initiateSession,
  encryptOutbound,
  decryptInbound,
  decryptInboundStateless,  // ← add this
} from '../crypto/session'
```