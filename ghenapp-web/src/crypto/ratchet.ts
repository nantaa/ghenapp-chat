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
  // ed25519ToX25519 requires a 64-byte Ed25519 secret key.
  // Guard: if only a 32-byte scalar, use it directly as X25519 private key.
  let senderIK: { privateKey: Uint8Array; publicKey: Uint8Array }
  if (senderIdentityPriv.length === 64) {
    senderIK = await ed25519ToX25519(senderIdentityPriv)
  } else {
    const s = await na()
    senderIK = { privateKey: senderIdentityPriv, publicKey: s.crypto_scalarmult_base(senderIdentityPriv) }
  }
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
  // ed25519ToX25519 requires exactly 64-byte Ed25519 secret key.
  // Guard: if we only have a 32-byte seed/scalar, treat it as raw X25519 private key.
  let recipIK: { privateKey: Uint8Array }
  if (recipientIdentityPriv.length === 64) {
    recipIK = await ed25519ToX25519(recipientIdentityPriv)
  } else {
    recipIK = { privateKey: recipientIdentityPriv }
  }
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

export function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toHex(b: Uint8Array) {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

export interface RatchetState {
  rootKey: Uint8Array
  sendChainKey: Uint8Array | null
  recvChainKey: Uint8Array | null
  sendMsgNum: number
  recvMsgNum: number
  prevSendMsgNum: number
  skippedKeys: Record<string, Uint8Array>
  dhs: { publicKey: Uint8Array, privateKey: Uint8Array }
  dhr: Uint8Array | null
  role?: 'initiator' | 'responder'
  epoch?: number
  ephemeralPubKey?: Uint8Array
}

async function kdfRk(rk: Uint8Array, dhOut: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const s = await na()
  const prk = s.crypto_generichash(32, dhOut, rk)
  const info = new TextEncoder().encode('GhenApp-DR-RK-CK')
  const out1 = s.crypto_generichash(32, new Uint8Array([...info, 0x01]), prk)
  const out2 = s.crypto_generichash(32, new Uint8Array([...out1, ...info, 0x02]), prk)
  return [out1, out2]
}

async function kdfCk(ck: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const s = await na()
  const msgKey = s.crypto_auth_hmacsha256(new Uint8Array([0x01]), ck)
  const nextCk = s.crypto_auth_hmacsha256(new Uint8Array([0x02]), ck)
  return [nextCk, msgKey]
}

export async function initRatchetInitiator(masterSecret: Uint8Array, recipientSpkPubX: Uint8Array): Promise<RatchetState> {
  const s = await na()
  const dhs = s.crypto_box_keypair()
  const dhr = recipientSpkPubX
  
  const dhOut = s.crypto_scalarmult(dhs.privateKey, dhr)
  const [rootKey, sendChainKey] = await kdfRk(masterSecret, dhOut)
  
  return {
    rootKey,
    sendChainKey,
    recvChainKey: null,
    sendMsgNum: 0,
    recvMsgNum: 0,
    prevSendMsgNum: 0,
    skippedKeys: {},
    dhs,
    dhr,
    role: 'initiator'
  }
}

export async function initRatchetResponder(masterSecret: Uint8Array, mySpkPrivX: Uint8Array, senderEphemeralPub: Uint8Array): Promise<RatchetState> {
  const s = await na()
  const pub = s.crypto_scalarmult_base(mySpkPrivX)
  const dhs = { privateKey: mySpkPrivX, publicKey: pub }
  
  return {
    rootKey: masterSecret,
    sendChainKey: null,
    recvChainKey: null,
    sendMsgNum: 0,
    recvMsgNum: 0,
    prevSendMsgNum: 0,
    skippedKeys: {},
    dhs,
    dhr: null,
    role: 'responder',
    epoch: Date.now(),
    ephemeralPubKey: senderEphemeralPub
  }
}

async function trySkipMessageKeys(state: RatchetState, until: number) {
  if (state.recvChainKey === null) return
  if (state.recvMsgNum + 2000 < until) throw new Error('Too many skipped messages')
  let ck = state.recvChainKey
  for (let i = state.recvMsgNum; i < until; i++) {
    const [nextCk, mk] = await kdfCk(ck)
    state.skippedKeys[`${toHex(state.dhr!)}_${i}`] = mk
    ck = nextCk
  }
  state.recvChainKey = ck
  state.recvMsgNum = until
}

async function advanceSendChain(state: RatchetState): Promise<{ msgKey: Uint8Array; nextState: RatchetState }> {
  if (state.sendChainKey === null) throw new Error('Cannot send before receiving a reply')
  const [nextCk, msgKey] = await kdfCk(state.sendChainKey)
  const nextState = { ...state, sendChainKey: nextCk, sendMsgNum: state.sendMsgNum + 1 }
  return { msgKey, nextState }
}

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────────────

export interface EncryptedMessage {
  dhPub: Uint8Array
  pn: number
  msgNum: number
  nonce: Uint8Array
  ciphertext: Uint8Array
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
    encrypted: {
      dhPub: nextState.dhs.publicKey,
      pn: nextState.prevSendMsgNum,
      msgNum: state.sendMsgNum,
      nonce,
      ciphertext
    },
    nextState
  }
}

export async function decryptMessage(
  encrypted: EncryptedMessage,
  state: RatchetState,
): Promise<{ plaintext: Uint8Array; nextState: RatchetState }> {
  const skipKey = `${toHex(encrypted.dhPub)}_${encrypted.msgNum}`
  let msgKey: Uint8Array
  let nextState = { ...state, skippedKeys: { ...state.skippedKeys } }
  
  if (nextState.skippedKeys[skipKey]) {
    msgKey = nextState.skippedKeys[skipKey]
    delete nextState.skippedKeys[skipKey]
  } else {
    if (!nextState.dhr || !bytesEqual(nextState.dhr, encrypted.dhPub)) {
      await trySkipMessageKeys(nextState, encrypted.pn)
      const s = await na()
      nextState.dhr = encrypted.dhPub
      const dhOut1 = s.crypto_scalarmult(nextState.dhs.privateKey, nextState.dhr)
      const [rk1, ckr] = await kdfRk(nextState.rootKey, dhOut1)
      nextState.rootKey = rk1
      nextState.recvChainKey = ckr
      
      nextState.prevSendMsgNum = nextState.sendMsgNum
      nextState.sendMsgNum = 0
      nextState.recvMsgNum = 0
      nextState.dhs = s.crypto_box_keypair()
      
      const dhOut2 = s.crypto_scalarmult(nextState.dhs.privateKey, nextState.dhr)
      const [rk2, cks] = await kdfRk(nextState.rootKey, dhOut2)
      nextState.rootKey = rk2
      nextState.sendChainKey = cks
    }
    
    await trySkipMessageKeys(nextState, encrypted.msgNum)
    if (nextState.recvChainKey === null) throw new Error('recvChainKey is null')
    
    const [nextCk, mk] = await kdfCk(nextState.recvChainKey)
    nextState.recvChainKey = nextCk
    nextState.recvMsgNum++
    msgKey = mk
  }
  
  const s = await na()
  const plaintext = s.crypto_secretbox_open_easy(encrypted.ciphertext, encrypted.nonce, msgKey)
  return { plaintext, nextState }
}

// ─── Session Store (IndexedDB) ───────────────────────────────────────────────────────────

export const SESSION_DB = 'ghenapp-sessions'
export const SESSION_VER = 2

export const SESSION_STORE = 'ratchet'

export async function sessionDB() {
  return openDB(SESSION_DB, SESSION_VER, {
    upgrade(db, oldVer, _newVer, tx) {
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE)
      } else if (oldVer < 2) {
        tx.objectStore(SESSION_STORE).clear()
      }
    },
  })
}

export async function saveSession(conversationId: string, state: RatchetState): Promise<void> {
  const db = await sessionDB()
  await db.put(SESSION_STORE, {
    rootKey: Array.from(state.rootKey),
    sendChainKey: state.sendChainKey ? Array.from(state.sendChainKey) : null,
    recvChainKey: state.recvChainKey ? Array.from(state.recvChainKey) : null,
    sendMsgNum: state.sendMsgNum,
    recvMsgNum: state.recvMsgNum,
    prevSendMsgNum: state.prevSendMsgNum,
    role: state.role ?? 'initiator',
    skippedKeys: Object.fromEntries(
      Object.entries(state.skippedKeys).map(([k, v]) => [k, Array.from(v)])
    ),
    dhs: {
      publicKey: Array.from(state.dhs.publicKey),
      privateKey: Array.from(state.dhs.privateKey)
    },
    dhr: state.dhr ? Array.from(state.dhr) : null,
    epoch: state.epoch,
    ephemeralPubKey: state.ephemeralPubKey ? Array.from(state.ephemeralPubKey) : undefined
  }, conversationId)
}

export async function loadSession(conversationId: string): Promise<RatchetState | null> {
  const db = await sessionDB()
  const raw = await db.get(SESSION_STORE, conversationId)
  if (!raw || !raw.dhs) return null // Drop old v1 sessions
  return {
    rootKey: new Uint8Array(raw.rootKey),
    sendChainKey: raw.sendChainKey ? new Uint8Array(raw.sendChainKey) : null,
    recvChainKey: raw.recvChainKey ? new Uint8Array(raw.recvChainKey) : null,
    sendMsgNum: raw.sendMsgNum,
    recvMsgNum: raw.recvMsgNum,
    prevSendMsgNum: raw.prevSendMsgNum,
    role: raw.role ?? 'initiator',
    skippedKeys: Object.fromEntries(
      Object.entries(raw.skippedKeys || {}).map(([k, v]) => [k, new Uint8Array(v as any)])
    ),
    dhs: {
      publicKey: new Uint8Array(raw.dhs.publicKey),
      privateKey: new Uint8Array(raw.dhs.privateKey)
    },
    dhr: raw.dhr ? new Uint8Array(raw.dhr) : null,
    epoch: raw.epoch,
    ephemeralPubKey: raw.ephemeralPubKey ? new Uint8Array(raw.ephemeralPubKey) : undefined
  }
}

export async function deleteSession(conversationId: string): Promise<void> {
  const db = await sessionDB()
  await db.delete(SESSION_STORE, conversationId)
}

// ─── Wire serialisation ───────────────────────────────────────────────────────────────

export function packEncryptedMessage(em: EncryptedMessage): Uint8Array {
  const buf = new Uint8Array(32 + 4 + 4 + 1 + em.nonce.length + em.ciphertext.length)
  buf.set(em.dhPub, 0)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint32(32, em.pn, false)
  view.setUint32(36, em.msgNum, false)
  buf[40] = em.nonce.length
  buf.set(em.nonce, 41)
  buf.set(em.ciphertext, 41 + em.nonce.length)
  return buf
}

export function unpackEncryptedMessage(data: Uint8Array): EncryptedMessage {
  const dhPub = data.slice(0, 32)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const pn = view.getUint32(32, false)
  const msgNum = view.getUint32(36, false)
  const nonceLen = data[40]
  const nonce = data.slice(41, 41 + nonceLen)
  const ciphertext = data.slice(41 + nonceLen)
  return { dhPub, pn, msgNum, nonce, ciphertext }
}
