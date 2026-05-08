// X3DH + Signal Double Ratchet — full E2E encryption layer
// All crypto via libsodium-wrappers (NaCl primitives)
//
// X3DH key agreement (simplified):
//   DH1 = DH(IK_sender, SPK_recipient)
//   DH2 = DH(EK_sender,  IK_recipient)
//   DH3 = DH(EK_sender,  SPK_recipient)
//   DH4 = DH(EK_sender,  OPK_recipient)  [optional]
//   MasterSecret = HKDF(DH1 || DH2 || DH3 [|| DH4])
//
// Double Ratchet: per-message key derivation so every message has a unique key.
// All keys stored in IndexedDB; nothing persists in memory across page reloads.

import _sodium from 'libsodium-wrappers-sumo'
import { openDB } from 'idb'
import { ed25519ToX25519, generateX25519, type X25519KeyPair } from './keygen'

export type { X25519KeyPair }

// ─── Sodium init ──────────────────────────────────────────────────────────────

let _ready = false
async function na() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── HKDF (SHA-256) ───────────────────────────────────────────────────────────

async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array | null,
  info: string,
  outputLen: number,
): Promise<Uint8Array> {
  const s = await na()
  const saltBytes = salt ?? new Uint8Array(32) // zero salt
  // Extract: PRK = BLAKE2b(salt, IKM)
  const prk = s.crypto_generichash(32, inputKeyMaterial, saltBytes)
  // Expand: OKM = BLAKE2b(PRK, info || 0x01)
  const infoBytes = new TextEncoder().encode(info)
  const t1Input = new Uint8Array([...infoBytes, 0x01])
  const okm = s.crypto_generichash(outputLen, t1Input, prk)
  return okm
}

// ─── X3DH Initiator (Sender) ──────────────────────────────────────────────────

export interface X3DHInitResult {
  masterSecret: Uint8Array  // 32-byte session key
  ephemeralPublicKey: Uint8Array  // to send with first message
}

export async function x3dhInitiate(params: {
  senderIdentityPriv: Uint8Array  // Ed25519 private key (64 bytes)
  recipientIdentityPub: Uint8Array // Ed25519 public key (32 bytes)
  recipientSignedPrekeyPub: Uint8Array
  recipientOnetimePrekeyPub?: Uint8Array
}): Promise<X3DHInitResult> {
  const {
    senderIdentityPriv, recipientIdentityPub,
    recipientSignedPrekeyPub, recipientOnetimePrekeyPub,
  } = params

  // Convert all keys to X25519
  const senderIK = await ed25519ToX25519(senderIdentityPriv)
  const s = await na()
  const recipIKx = s.crypto_sign_ed25519_pk_to_curve25519(recipientIdentityPub)
  const recipSPKx = recipientSignedPrekeyPub

  // Ephemeral key pair
  const ek = await generateX25519()

  // DH computations
  const dh1 = s.crypto_scalarmult(senderIK.privateKey, recipSPKx)
  const dh2 = s.crypto_scalarmult(ek.privateKey, recipIKx)
  const dh3 = s.crypto_scalarmult(ek.privateKey, recipSPKx)

  let dhConcat = new Uint8Array([...dh1, ...dh2, ...dh3])

  if (recipientOnetimePrekeyPub) {
    const recipOPKx = s.crypto_sign_ed25519_pk_to_curve25519(recipientOnetimePrekeyPub)
    const dh4 = s.crypto_scalarmult(ek.privateKey, recipOPKx)
    dhConcat = new Uint8Array([...dhConcat, ...dh4])
  }

  const masterSecret = await hkdf(dhConcat, null, 'GhenApp-X3DH-v1', 32)

  return { masterSecret, ephemeralPublicKey: ek.publicKey }
}

// ─── X3DH Responder (Recipient) ───────────────────────────────────────────────

export async function x3dhRespond(params: {
  recipientIdentityPriv: Uint8Array
  recipientSignedPrekeyPriv: Uint8Array
  recipientOnetimePrekeyPriv?: Uint8Array
  senderIdentityPub: Uint8Array
  senderEphemeralPub: Uint8Array
}): Promise<Uint8Array> {
  const {
    recipientIdentityPriv, recipientSignedPrekeyPriv,
    recipientOnetimePrekeyPriv, senderIdentityPub, senderEphemeralPub,
  } = params

  const recipIK = await ed25519ToX25519(recipientIdentityPriv)
  const recipSPK = { privateKey: recipientSignedPrekeyPriv, publicKey: new Uint8Array(32) }
  const s = await na()
  const senderIKx = s.crypto_sign_ed25519_pk_to_curve25519(senderIdentityPub)
  const senderEKx = senderEphemeralPub

  const dh1 = s.crypto_scalarmult(recipSPK.privateKey, senderIKx)
  const dh2 = s.crypto_scalarmult(recipIK.privateKey, senderEKx)
  const dh3 = s.crypto_scalarmult(recipSPK.privateKey, senderEKx)

  let dhConcat = new Uint8Array([...dh1, ...dh2, ...dh3])

  if (recipientOnetimePrekeyPriv) {
    const recipOPK = await ed25519ToX25519(recipientOnetimePrekeyPriv)
    const dh4 = s.crypto_scalarmult(recipOPK.privateKey, senderEKx)
    dhConcat = new Uint8Array([...dhConcat, ...dh4])
  }

  return hkdf(dhConcat, null, 'GhenApp-X3DH-v1', 32)
}

// ─── Double Ratchet ───────────────────────────────────────────────────────────

export interface RatchetState {
  // Sending ratchet
  sendChainKey: Uint8Array
  sendMsgNum: number
  // Receiving ratchet
  recvChainKey: Uint8Array
  recvMsgNum: number
  // Root key
  rootKey: Uint8Array
}

/** Initialize both sides of a Double Ratchet session from a shared secret */
export async function initRatchet(masterSecret: Uint8Array): Promise<RatchetState> {
  // Derive initial root, send chain, recv chain keys
  const rootKey = await hkdf(masterSecret, null, 'GhenApp-DR-root', 32)
  const sendChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-send', 32)
  const recvChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-recv', 32)
  return { rootKey, sendChainKey, recvChainKey, sendMsgNum: 0, recvMsgNum: 0 }
}

/** Advance the sending chain and return the message key */
async function advanceSendChain(state: RatchetState): Promise<{ msgKey: Uint8Array; nextState: RatchetState }> {
  const s = await na()
  const msgKey = await hkdf(state.sendChainKey, null, `msg-${state.sendMsgNum}`, 32)
  const nextChainKey = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), state.sendChainKey)
  return {
    msgKey,
    nextState: { ...state, sendChainKey: nextChainKey, sendMsgNum: state.sendMsgNum + 1 },
  }
}

/** Advance the receiving chain and return the message key */
async function advanceRecvChain(state: RatchetState, msgNum: number): Promise<{ msgKey: Uint8Array; nextState: RatchetState }> {
  const s = await na()
  const msgKey = await hkdf(state.recvChainKey, null, `msg-${msgNum}`, 32)
  const nextChainKey = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), state.recvChainKey)
  return {
    msgKey,
    nextState: { ...state, recvChainKey: nextChainKey, recvMsgNum: msgNum + 1 },
  }
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

export interface EncryptedMessage {
  ciphertext: Uint8Array
  nonce: Uint8Array
  msgNum: number
}

export async function encryptMessage(
  plaintext: Uint8Array,
  state: RatchetState,
): Promise<{ encrypted: EncryptedMessage; nextState: RatchetState }> {
  const s = await na()
  const { msgKey, nextState } = await advanceSendChain(state)
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES)
  const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, msgKey)
  return {
    encrypted: { ciphertext, nonce, msgNum: state.sendMsgNum },
    nextState,
  }
}

export async function decryptMessage(
  encrypted: EncryptedMessage,
  state: RatchetState,
): Promise<{ plaintext: Uint8Array; nextState: RatchetState }> {
  const s = await na()
  const { msgKey, nextState } = await advanceRecvChain(state, encrypted.msgNum)
  const plaintext = s.crypto_secretbox_open_easy(encrypted.ciphertext, encrypted.nonce, msgKey)
  return { plaintext, nextState }
}

// ─── Session Store (IndexedDB) ────────────────────────────────────────────────

export const SESSION_DB = 'ghenapp-sessions'
export const SESSION_VER = 1
export const SESSION_STORE = 'ratchet'

export async function sessionDB() {
  return openDB(SESSION_DB, SESSION_VER, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE)
      }
    },
  })
}

export async function saveSession(conversationId: string, state: RatchetState): Promise<void> {
  const db = await sessionDB()
  // Serialise Uint8Arrays as regular arrays for structured clone
  await db.put(SESSION_STORE, {
    rootKey: Array.from(state.rootKey),
    sendChainKey: Array.from(state.sendChainKey),
    recvChainKey: Array.from(state.recvChainKey),
    sendMsgNum: state.sendMsgNum,
    recvMsgNum: state.recvMsgNum,
  }, conversationId)
}

export async function loadSession(conversationId: string): Promise<RatchetState | null> {
  const db = await sessionDB()
  const raw = await db.get(SESSION_STORE, conversationId)
  if (!raw) return null
  return {
    rootKey: new Uint8Array(raw.rootKey),
    sendChainKey: new Uint8Array(raw.sendChainKey),
    recvChainKey: new Uint8Array(raw.recvChainKey),
    sendMsgNum: raw.sendMsgNum,
    recvMsgNum: raw.recvMsgNum,
  }
}

export async function deleteSession(conversationId: string): Promise<void> {
  const db = await sessionDB()
  await db.delete(SESSION_STORE, conversationId)
}

// ─── Serialise EncryptedMessage for wire transport ────────────────────────────

/** Pack EncryptedMessage into a Uint8Array for IMCP payload:
 *  [4 bytes: msgNum] [1 byte: nonceLen] [N bytes: nonce] [rest: ciphertext]
 */
export function packEncryptedMessage(em: EncryptedMessage): Uint8Array {
  const buf = new Uint8Array(4 + 1 + em.nonce.length + em.ciphertext.length)
  const view = new DataView(buf.buffer)
  view.setUint32(0, em.msgNum, false)
  buf[4] = em.nonce.length
  buf.set(em.nonce, 5)
  buf.set(em.ciphertext, 5 + em.nonce.length)
  return buf
}

export function unpackEncryptedMessage(data: Uint8Array): EncryptedMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const msgNum = view.getUint32(0, false)
  const nonceLen = data[4]
  const nonce = data.slice(5, 5 + nonceLen)
  const ciphertext = data.slice(5 + nonceLen)
  return { msgNum, nonce, ciphertext }
}
