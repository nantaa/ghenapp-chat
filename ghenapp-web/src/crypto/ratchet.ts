// X3DH + Double Ratchet — full E2E encryption layer
// All crypto via libsodium-wrappers (NaCl primitives)

import _sodium from 'libsodium-wrappers-sumo'
import { openDB } from 'idb'
import { ed25519ToX25519, generateX25519, type X25519KeyPair } from './keygen'

export type { X25519KeyPair }

let _ready = false
async function na() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── HKDF (BLAKE2b-based) ────────────────────────────────────────────────────────────

async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array | null,
  info: string,
  outputLen: number,
): Promise<Uint8Array> {
  const s = await na()
  const saltBytes = salt ?? new Uint8Array(32)
  const prk = s.crypto_generichash(32, inputKeyMaterial, saltBytes)
  const infoBytes = new TextEncoder().encode(info)
  const t1Input = new Uint8Array([...infoBytes, 0x01])
  return s.crypto_generichash(outputLen, t1Input, prk)
}

// ─── X3DH Initiator ───────────────────────────────────────────────────────────────

export interface X3DHInitResult {
  masterSecret: Uint8Array
  ephemeralPublicKey: Uint8Array
}

export async function x3dhInitiate(params: {
  senderIdentityPriv: Uint8Array
  recipientIdentityPub: Uint8Array
  recipientSignedPrekeyPub: Uint8Array
  recipientOnetimePrekeyPub?: Uint8Array
}): Promise<X3DHInitResult> {
  const { senderIdentityPriv, recipientIdentityPub, recipientSignedPrekeyPub, recipientOnetimePrekeyPub } = params
  const senderIK = await ed25519ToX25519(senderIdentityPriv)
  const s = await na()
  const recipIKx = s.crypto_sign_ed25519_pk_to_curve25519(recipientIdentityPub)
  const recipSPKx = recipientSignedPrekeyPub
  const ek = await generateX25519()

  const dh1 = s.crypto_scalarmult(senderIK.privateKey, recipSPKx)
  const dh2 = s.crypto_scalarmult(ek.privateKey, recipIKx)
  const dh3 = s.crypto_scalarmult(ek.privateKey, recipSPKx)
  let dhConcat = new Uint8Array([...dh1, ...dh2, ...dh3])

  if (recipientOnetimePrekeyPub) {
    const dh4 = s.crypto_scalarmult(ek.privateKey, recipientOnetimePrekeyPub)
    dhConcat = new Uint8Array([...dhConcat, ...dh4])
  }

  const masterSecret = await hkdf(dhConcat, null, 'GhenApp-X3DH-v1', 32)
  return { masterSecret, ephemeralPublicKey: ek.publicKey }
}

// ─── X3DH Responder ───────────────────────────────────────────────────────────────

export async function x3dhRespond(params: {
  recipientIdentityPriv: Uint8Array
  recipientSignedPrekeyPriv: Uint8Array
  recipientOnetimePrekeyPriv?: Uint8Array
  senderIdentityPub: Uint8Array
  senderEphemeralPub: Uint8Array
}): Promise<Uint8Array> {
  const { recipientIdentityPriv, recipientSignedPrekeyPriv, recipientOnetimePrekeyPriv, senderIdentityPub, senderEphemeralPub } = params
  const recipIK = await ed25519ToX25519(recipientIdentityPriv)
  let spkPriv = recipientSignedPrekeyPriv
  if (spkPriv.length === 64) spkPriv = (await ed25519ToX25519(spkPriv)).privateKey

  const s = await na()
  const senderIKx = s.crypto_sign_ed25519_pk_to_curve25519(senderIdentityPub)
  const senderEKx = senderEphemeralPub

  const dh1 = s.crypto_scalarmult(spkPriv, senderIKx)
  const dh2 = s.crypto_scalarmult(recipIK.privateKey, senderEKx)
  const dh3 = s.crypto_scalarmult(spkPriv, senderEKx)
  let dhConcat = new Uint8Array([...dh1, ...dh2, ...dh3])

  if (recipientOnetimePrekeyPriv) {
    const dh4 = s.crypto_scalarmult(recipientOnetimePrekeyPriv, senderEKx)
    dhConcat = new Uint8Array([...dhConcat, ...dh4])
  }

  return hkdf(dhConcat, null, 'GhenApp-X3DH-v1', 32)
}

// ─── Double Ratchet ───────────────────────────────────────────────────────────────

export interface RatchetState {
  sendChainKey: Uint8Array
  sendMsgNum: number
  recvChainKey: Uint8Array
  recvMsgNum: number
  rootKey: Uint8Array
  skippedKeys: Record<number, Uint8Array>
  // Identifies which side derived this state, for debugging
  role?: 'initiator' | 'responder'
}

// S-14: Use side-specific HKDF labels so initiator and responder derive
// DIFFERENT chain keys from the same master secret — no swap needed.
//
// Initiator:  sendChain = hkdf(ms, 'GhenApp-DR-initiator-send')
//             recvChain = hkdf(ms, 'GhenApp-DR-responder-send')  ← responder's send
//
// Responder:  sendChain = hkdf(ms, 'GhenApp-DR-responder-send')
//             recvChain = hkdf(ms, 'GhenApp-DR-initiator-send')  ← initiator's send
//
// By construction: initiator.sendChain === responder.recvChain  ✔
//                  responder.sendChain === initiator.recvChain  ✔

export async function initRatchetInitiator(masterSecret: Uint8Array): Promise<RatchetState> {
  const rootKey    = await hkdf(masterSecret, null, 'GhenApp-DR-root', 32)
  const sendChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-initiator-send', 32)
  const recvChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-responder-send', 32)
  return { rootKey, sendChainKey, recvChainKey, sendMsgNum: 0, recvMsgNum: 0, skippedKeys: {}, role: 'initiator' }
}

export async function initRatchetResponder(masterSecret: Uint8Array): Promise<RatchetState> {
  const rootKey    = await hkdf(masterSecret, null, 'GhenApp-DR-root', 32)
  const sendChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-responder-send', 32)
  const recvChainKey = await hkdf(masterSecret, null, 'GhenApp-DR-initiator-send', 32)
  return { rootKey, sendChainKey, recvChainKey, sendMsgNum: 0, recvMsgNum: 0, skippedKeys: {}, role: 'responder' }
}

/** @deprecated use initRatchetInitiator / initRatchetResponder */
export async function initRatchet(masterSecret: Uint8Array): Promise<RatchetState> {
  return initRatchetInitiator(masterSecret)
}

async function advanceSendChain(state: RatchetState): Promise<{ msgKey: Uint8Array; nextState: RatchetState }> {
  const s = await na()
  const msgKey = await hkdf(state.sendChainKey, null, `msg-${state.sendMsgNum}`, 32)
  const nextChainKey = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), state.sendChainKey)
  return { msgKey, nextState: { ...state, sendChainKey: nextChainKey, sendMsgNum: state.sendMsgNum + 1 } }
}

async function advanceRecvChain(state: RatchetState, msgNum: number): Promise<{ msgKey: Uint8Array; nextState: RatchetState }> {
  if (msgNum < state.recvMsgNum) {
    const savedKey = state.skippedKeys[msgNum]
    if (!savedKey) throw new Error(`Cannot decrypt old message: ${msgNum}`)
    const nextSkipped = { ...state.skippedKeys }
    delete nextSkipped[msgNum]
    return { msgKey: savedKey, nextState: { ...state, skippedKeys: nextSkipped } }
  }

  const s = await na()
  let currChainKey = state.recvChainKey
  const nextSkipped = { ...state.skippedKeys }

  for (let i = state.recvMsgNum; i < msgNum; i++) {
    const mk = await hkdf(currChainKey, null, `msg-${i}`, 32)
    nextSkipped[i] = mk
    currChainKey = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), currChainKey)
  }

  const msgKey = await hkdf(currChainKey, null, `msg-${msgNum}`, 32)
  const nextChainKey = s.crypto_generichash(32, new TextEncoder().encode('chain-advance'), currChainKey)
  return { msgKey, nextState: { ...state, recvChainKey: nextChainKey, recvMsgNum: msgNum + 1, skippedKeys: nextSkipped } }
}

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────────────

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
  return { encrypted: { ciphertext, nonce, msgNum: state.sendMsgNum }, nextState }
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

// ─── Session Store (IndexedDB) ───────────────────────────────────────────────────────────

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
  await db.put(SESSION_STORE, {
    rootKey: Array.from(state.rootKey),
    sendChainKey: Array.from(state.sendChainKey),
    recvChainKey: Array.from(state.recvChainKey),
    sendMsgNum: state.sendMsgNum,
    recvMsgNum: state.recvMsgNum,
    role: state.role ?? 'initiator',
    skippedKeys: Object.fromEntries(
      Object.entries(state.skippedKeys).map(([k, v]) => [k, Array.from(v)])
    ),
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
    role: raw.role ?? 'initiator',
    skippedKeys: Object.fromEntries(
      Object.entries(raw.skippedKeys || {}).map(([k, v]) => [k, new Uint8Array(v as any)])
    ),
  }
}

export async function deleteSession(conversationId: string): Promise<void> {
  const db = await sessionDB()
  await db.delete(SESSION_STORE, conversationId)
}

// ─── Wire serialisation ───────────────────────────────────────────────────────────────

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
