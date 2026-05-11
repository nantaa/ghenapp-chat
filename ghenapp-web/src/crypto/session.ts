// Crypto session manager — ties together X3DH + Ratchet with the API layer
// Handles: initiating a session, encrypting outbound, decrypting inbound messages

import * as api from '../lib/api'
import {
  x3dhInitiate,
  x3dhRespond,
  initRatchet,
  encryptMessage,
  decryptMessage,
  packEncryptedMessage,
  unpackEncryptedMessage,
  loadSession,
  saveSession,
  sessionDB,
  SESSION_STORE,
  type RatchetState,
} from './ratchet'
import { loadPrivateKey } from './keygen'

// ─── Key decoding helper ─────────────────────────────────────────────────────

function decodePubKey(raw: unknown, label: string): Uint8Array {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label}: key is missing or empty (received ${JSON.stringify(raw)}). The user may not have completed registration on this device.`)
  }
  if (raw.length !== 32) {
    throw new Error(`${label}: expected 32 bytes but got ${raw.length}. The key stored on the server appears corrupted — ask the user to re-register.`)
  }
  return new Uint8Array(raw as number[])
}

// ─── Session Initiation ───────────────────────────────────────────────────────

export async function initiateSession(
  myUsername: string,
  recipientUsername: string,
  conversationId: string,
  forceReset = false,
): Promise<void> {
  const existing = await loadSession(conversationId)
  if (existing && !forceReset) return

  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found — please register on this device first.')

  const bundle = await api.getPrekeys(recipientUsername)
  if (!bundle) throw new Error(`No prekey bundle found for "${recipientUsername}".`)

  if (!bundle.signed_prekey?.public_key?.length) {
    throw new Error(`"${recipientUsername}" has no prekeys on the server. Ask them to sign out and re-register.`)
  }

  const recipientIdentityPub = decodePubKey(bundle.public_key, `"${recipientUsername}" identity key`)
  const recipientSignedPrekey = decodePubKey(bundle.signed_prekey.public_key, `"${recipientUsername}" signed prekey`)
  const recipientOnetimePrekey = bundle.onetime_prekey?.public_key?.length === 32
    ? new Uint8Array(bundle.onetime_prekey.public_key)
    : undefined

  const { masterSecret, ephemeralPublicKey } = await x3dhInitiate({
    senderIdentityPriv: myPrivKey,
    recipientIdentityPub,
    recipientSignedPrekeyPub: recipientSignedPrekey,
    recipientOnetimePrekeyPub: recipientOnetimePrekey,
  })

  const ratchetState = await initRatchet(masterSecret)
  // Initiator: sendMsgNum starts at 0, recvMsgNum starts at 0
  const initiatorState: RatchetState = {
    ...ratchetState,
    sendMsgNum: 0,
    recvMsgNum: 0,
    skippedKeys: {},
  }
  await saveSession(conversationId, initiatorState)
  await _storeEphemeralPub(conversationId, ephemeralPublicKey, recipientOnetimePrekey)
}

export async function acceptSession(
  myUsername: string,
  senderIdentityPub: Uint8Array,
  senderEphemeralPub: Uint8Array,
  conversationId: string,
  _usedOnetimePrekey: boolean,
  usedOpkPub?: Uint8Array,
): Promise<void> {
  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found.')

  const mySignedPrekeyPriv = await loadPrivateKey(`spk:${myUsername}`) ?? myPrivKey

  // Look up the OPK private key by the public key bytes embedded in the frame
  let opkPriv: Uint8Array | undefined
  if (usedOpkPub && usedOpkPub.length === 32) {
    const pubHex = Array.from(usedOpkPub).map(b => b.toString(16).padStart(2, '0')).join('')
    const loaded = await loadPrivateKey(`opk-pub:${myUsername}:${pubHex}`)
    if (loaded) opkPriv = loaded
  }

  const masterSecret = await x3dhRespond({
    recipientIdentityPriv: myPrivKey,
    recipientSignedPrekeyPriv: mySignedPrekeyPriv,
    recipientOnetimePrekeyPriv: opkPriv,
    senderIdentityPub,
    senderEphemeralPub,
  })

  const ratchetState = await initRatchet(masterSecret)

  const responderState: RatchetState = {
    ...ratchetState,
    sendChainKey: ratchetState.recvChainKey,
    recvChainKey: ratchetState.sendChainKey,
    // CRITICAL: reset both counters — a fresh 0x02 means a brand new session
    sendMsgNum: 0,
    recvMsgNum: 0,
    skippedKeys: {},
  }
  await saveSession(conversationId, responderState)
}

// ─── Encrypt outbound ─────────────────────────────────────────────────────────

export async function encryptOutbound(
  plaintext: string,
  conversationId: string,
  _myUsername?: string,
): Promise<Uint8Array> {
  let state = await loadSession(conversationId)
  if (!state) throw new Error(`No E2E session for ${conversationId}. Call initiateSession first.`)

  const { encrypted, nextState } = await encryptMessage(
    new TextEncoder().encode(plaintext),
    state,
  )
  await saveSession(conversationId, nextState)
  const packed = packEncryptedMessage(encrypted)

  const ephemData = await getEphemeralData(conversationId)
  if (ephemData && _myUsername) {
    const myPrivKey = await loadPrivateKey(_myUsername)
    if (myPrivKey) {
      // Ed25519 private key is 64 bytes: [seed(32) | pub(32)]
      // bytes 32..63 are the Ed25519 public key — used verbatim so the responder
      // can call crypto_sign_ed25519_pk_to_curve25519 on it
      const myPub = myPrivKey.slice(32, 64)
      const opkPub = ephemData.opkPub ?? new Uint8Array(32) // 32 zero bytes = no OPK
      // Frame format 0x02:
      // [1: type=0x02][32: senderIdentityPub][32: ephemeralPub][32: opkPub used][rest: packed]
      const buf = new Uint8Array(1 + 32 + 32 + 32 + packed.length)
      buf[0] = 0x02
      buf.set(myPub, 1)
      buf.set(ephemData.ephemPub, 33)
      buf.set(opkPub, 65)
      buf.set(packed, 97)
      await _deleteEphemeralData(conversationId)
      return buf
    }
  }

  const buf = new Uint8Array(1 + packed.length)
  buf[0] = 0x01
  buf.set(packed, 1)
  return buf
}

// Queue to prevent concurrent Double Ratchet operations which corrupt the state chain
const decryptQueue: Record<string, Promise<any>> = {}

export async function decryptInbound(
  payload: Uint8Array,
  conversationId: string,
  myUsername?: string,
): Promise<string | null> {
  // Ensure strict sequential processing per conversation
  if (!decryptQueue[conversationId]) {
    decryptQueue[conversationId] = Promise.resolve()
  }

  const task = decryptQueue[conversationId].then(() =>
    _decryptInboundInternal(payload, conversationId, myUsername)
  )
  decryptQueue[conversationId] = task.catch(() => null)
  return task
}

async function _decryptInboundInternal(
  payload: Uint8Array,
  conversationId: string,
  myUsername?: string,
): Promise<string | null> {
  const type = payload[0]
  let packed = payload

  if (type === 0x02) {
    const senderIdentityPub = payload.slice(1, 33)
    const senderEphemeralPub = payload.slice(33, 65)
    // Read the OPK pub used by the initiator (32 bytes starting at offset 65)
    const opkPubRaw = payload.slice(65, 97)
    // All-zero opkPub means no OPK was used
    const opkPub = opkPubRaw.some(b => b !== 0) ? opkPubRaw : undefined
    packed = payload.slice(97)

    // FIX: Always re-run acceptSession on every 0x02 frame, even if a session
    // already exists. This recovers from a previous failed handshake where
    // acceptSession threw but didn't save a valid session.
    if (myUsername) {
      try {
        await acceptSession(
          myUsername,
          senderIdentityPub,
          senderEphemeralPub,
          conversationId,
          opkPub !== undefined,
          opkPub,
        )
      } catch (e) {
        console.error('[session] acceptSession failed for conv', conversationId, e)
        return null
      }
    }
  } else if (type === 0x01) {
    packed = payload.slice(1)
  }

  const state = await loadSession(conversationId)
  if (!state) return null

  try {
    const encrypted = unpackEncryptedMessage(packed)
    const { plaintext, nextState } = await decryptMessage(encrypted, state)
    await saveSession(conversationId, nextState)
    return new TextDecoder().decode(plaintext)
  } catch (e) {
    console.error('[session] decryptMessage failed for conv', conversationId, e)
    return null
  }
}

// ─── Decrypt for history (read-only — does NOT advance ratchet state) ─────────
//
// IMPORTANT: Use this ONLY for loading cached history. It reads the current
// ratchet state as a snapshot and tries to decrypt from msgNum=0 upward.
// Because history messages should already be cached, this is a best-effort
// fallback that DOES NOT mutate the saved session state.
//
export async function decryptHistoryMessage(
  payload: Uint8Array,
  conversationId: string,
  myUsername?: string,
): Promise<string | null> {
  // History messages should come from localStorage cache first.
  // This function is only called when the cache misses (first time after reload).
  // It does NOT advance the live ratchet — it works on a snapshot.
  const state = await loadSession(conversationId)
  if (!state) return null

  const type = payload[0]
  if (type !== 0x01 && type !== 0x02) return null

  const packed = type === 0x02 ? payload.slice(97) : payload.slice(1)

  try {
    const { unpackEncryptedMessage } = await import('./ratchet')
    const encrypted = unpackEncryptedMessage(packed)

    // Derive the key directly from the msgNum WITHOUT advancing recvMsgNum
    // This is safe because we discard nextState — live ratchet is untouched
    const { hkdf } = await import('./ratchet') as any
    // Recompute the chain key for this specific msgNum from recvChainKey
    // We fast-forward a copy of the chain key without touching saved state
    const s = await (await import('libsodium-wrappers-sumo')).default
    await s.ready
    let ck = new Uint8Array(state.recvChainKey)
    for (let i = 0; i < encrypted.msgNum; i++) {
      ck = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), ck)
    }
    // Derive msgKey for this specific msgNum
    const infoBytes = new TextEncoder().encode(`msg-${encrypted.msgNum}`)
    const prkBytes = new Uint8Array([...infoBytes, 0x01])
    const prk = s.crypto_generichash(32, ck, new Uint8Array(32))
    const msgKey = s.crypto_generichash(32, prkBytes, prk)

    const plaintext = s.crypto_secretbox_open_easy(encrypted.ciphertext, encrypted.nonce, msgKey)
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

// suppress unused param warning — myUsername reserved for future device-scoped key lookup
void myUsername
}

// ─── Ephemeral key storage (IndexedDB) ───────────────────────────────────────

const EPHEM_PREFIX = 'ephem:'

async function _storeEphemeralPub(
  conversationId: string,
  ephemPub: Uint8Array,
  opkPub?: Uint8Array,
): Promise<void> {
  const db = await sessionDB()
  await db.put(SESSION_STORE, {
    ephemeralKey: Array.from(ephemPub),
    opkKey: opkPub ? Array.from(opkPub) : null,
  }, EPHEM_PREFIX + conversationId)
}

async function _deleteEphemeralData(conversationId: string): Promise<void> {
  const db = await sessionDB()
  await db.delete(SESSION_STORE, EPHEM_PREFIX + conversationId)
}

export async function getEphemeralData(
  conversationId: string,
): Promise<{ ephemPub: Uint8Array; opkPub: Uint8Array | null } | null> {
  const db = await sessionDB()
  const raw = await db.get(SESSION_STORE, EPHEM_PREFIX + conversationId)
  if (!raw?.ephemeralKey) return null
  return {
    ephemPub: new Uint8Array(raw.ephemeralKey as number[]),
    opkPub: raw.opkKey ? new Uint8Array(raw.opkKey as number[]) : null,
  }
}

/** @deprecated Use getEphemeralData instead */
export async function getEphemeralPub(conversationId: string): Promise<Uint8Array | undefined> {
  const data = await getEphemeralData(conversationId)
  return data?.ephemPub
}
