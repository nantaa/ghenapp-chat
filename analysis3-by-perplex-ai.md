Now I have the full picture. Here's what's **actually still broken** after all your fixes:

***

## The Real Remaining Bug: `decryptInboundStateless` uses a fresh `initRatchetResponder` with no `recvChainKey`

Look at this in `session.ts` :

```ts
// decryptInboundStateless
const tempState = await initRatchetResponder(masterSecret, mySpkPrivX, senderEphemeralPub)
const encrypted = unpackEncryptedMessage(packed)
const { plaintext } = await decryptMessage(encrypted, tempState)  // ← ALWAYS FAILS
```

And `initRatchetResponder` in `ratchet.ts` :

```ts
return {
  rootKey: masterSecret,
  sendChainKey: null,
  recvChainKey: null,   // ← NULL
  dhr: null,            // ← NULL
  ...
}
```

Then `decryptMessage` in `ratchet.ts` tries to do a DH ratchet step because `dhr` is null — but then calls `trySkipMessageKeys` which immediately returns because `recvChainKey` is also null — and then hits:

```ts
if (nextState.recvChainKey === null) throw new Error('recvChainKey is null')
```

**Every single call to `decryptInboundStateless` throws.** The function can never succeed. So your history loader gets `null` for every `0x02` peer message too. 

***

## The Fix: Responder needs to prime `recvChainKey` from the first message's `dhPub`

The responder's initial `recvChainKey` must be derived from the initiator's first ratchet DH public key (which is packed in the message itself). The `decryptMessage` flow already does a DH ratchet step when `dhr` doesn't match `encrypted.dhPub` — but it requires `recvChainKey` to already exist for `trySkipMessageKeys` first. The responder's first decrypt breaks this assumption.

The correct fix: after building `tempState` in `decryptInboundStateless`, **immediately do one DH ratchet step using the message's `dhPub`** to prime `recvChainKey` before calling `decryptMessage`:

```ts
// session.ts — decryptInboundStateless
const masterSecret = await x3dhRespond({ ... })
const tempState = await initRatchetResponder(masterSecret, mySpkPrivX, senderEphemeralPub)
const encrypted = unpackEncryptedMessage(packed)

// ── MISSING FIX: prime recvChainKey for the responder's first decrypt ──
// initRatchetResponder leaves recvChainKey=null and dhr=null.
// decryptMessage needs recvChainKey to exist before it can decrypt msg 0.
// We must do the first DH ratchet step manually here.
const s = await _sodium.ready  // already loaded
const primedState = { ...tempState }
const dhOut = sodium.crypto_scalarmult(primedState.dhs.privateKey, encrypted.dhPub)
const [newRk, recvCk] = await kdfRk(primedState.rootKey, dhOut)
primedState.rootKey = newRk
primedState.recvChainKey = recvCk
primedState.dhr = encrypted.dhPub

const { plaintext } = await decryptMessage(encrypted, primedState)
return new TextDecoder().decode(plaintext)
```

But `kdfRk` is not exported from `ratchet.ts`. The cleanest fix is to **export a `primeResponderState` helper** from `ratchet.ts`:

```ts
// ratchet.ts — add and export this
export async function primeResponderForFirstMessage(
  state: RatchetState,
  firstMsgDhPub: Uint8Array,
): Promise<RatchetState> {
  const s = await na()
  const dhOut = s.crypto_scalarmult(state.dhs.privateKey, firstMsgDhPub)
  const [newRk, recvCk] = await kdfRk(state.rootKey, dhOut)
  return {
    ...state,
    rootKey: newRk,
    recvChainKey: recvCk,
    dhr: firstMsgDhPub,
    recvMsgNum: 0,
  }
}
```

Then in `session.ts`:

```ts
import {
  ...,
  primeResponderForFirstMessage,  // ← add
} from './ratchet'

// In decryptInboundStateless:
const tempState = await initRatchetResponder(masterSecret, mySpkPrivX, senderEphemeralPub)
const encrypted = unpackEncryptedMessage(packed)
const primedState = await primeResponderForFirstMessage(tempState, encrypted.dhPub)  // ← add
const { plaintext } = await decryptMessage(encrypted, primedState)
```

The **same bug exists in `acceptSession`** — it calls `initRatchetResponder` and saves the state, which also has `recvChainKey: null`. So the first live `0x02` decrypt also fails after `acceptSession` runs, because `_decryptInboundInternal` loads the just-saved null state and calls `decryptMessage` on it. You need `primeResponderForFirstMessage` there too:

```ts
// session.ts — acceptSession, before saveSession
const ratchetState = await initRatchetResponder(masterSecret, mySpkPrivX, senderEphemeralPub)
// DO NOT save yet — caller will prime and decrypt first,
// saving happens inside decryptMessage via saveSession in _decryptInboundInternal
await saveSession(conversationId, ratchetState)
```

Actually the cleanest fix is: **call `primeResponderForFirstMessage` inside `initRatchetResponder` itself** using the `senderEphemeralPub` you already pass to it — since for the responder the first DH step is always against the initiator's ratchet public key, which is stored as `dhs.publicKey` in the initiator state... but wait, that's the initiator's *ratchet* key, not the ephemeral key. These are two different keys.

The **packed message's `dhPub`** (32 bytes at offset 0 of the packed ratchet payload) is the initiator's **ratchet DH public key** — this is generated fresh in `initRatchetInitiator` as `s.crypto_box_keypair()`. It is **NOT** the same as `senderEphemeralPub` (which is the X3DH ephemeral key). 

So `primeResponderForFirstMessage` must receive `encrypted.dhPub`, not `senderEphemeralPub`. The fix must be in the call site. 