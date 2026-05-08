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
): Promise<void> {
  const existing = await loadSession(conversationId)
  if (existing) return

  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found — please register on this device first.')

  const bundle = await api.getPrekeys(recipientUsername)
  if (!bundle) throw new Error(`No prekey bundle found for "${recipientUsername}".`)

  if (!bundle.signed_prekey?.public_key?.length) {
    throw new Error(`"${recipientUsername}" has no prekeys on the server. Ask them to sign out and re-register.`)
  }

  const recipientIdentityPub = decodePubKey(bundle.public_key, `"${recipientUsername}" identity key`)
  const recipientSignedPrekey = decodePubKey(bundle.signed_prekey.public_key, `"${recipientUsername}" signed prekey`)
  const _recipientOnetimePrekey = bundle.onetime_prekey?.public_key?.length === 32
    ? new Uint8Array(bundle.onetime_prekey.public_key)
    : undefined

  const { masterSecret, ephemeralPublicKey } = await x3dhInitiate({
    senderIdentityPriv: myPrivKey,
    recipientIdentityPub,
    recipientSignedPrekeyPub: recipientSignedPrekey,
    //recipientOnetimePrekeyPub: recipientOnetimePrekey,
  })

  const ratchetState = await initRatchet(masterSecret)
  await saveSession(conversationId, ratchetState)
  await _storeEphemeralPub(conversationId, ephemeralPublicKey)
}

export async function acceptSession(
  myUsername: string,
  senderIdentityPub: Uint8Array,
  senderEphemeralPub: Uint8Array,
  conversationId: string,
  _usedOnetimePrekey: boolean,
): Promise<void> {
  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found.')

  // FIX: load the actual signed prekey private key
  const mySignedPrekeyPriv = await loadPrivateKey(`spk:${myUsername}`) ?? myPrivKey

  const masterSecret = await x3dhRespond({
    recipientIdentityPriv: myPrivKey,
    recipientSignedPrekeyPriv: mySignedPrekeyPriv,   // ← was: myPrivKey
    senderIdentityPub,
    senderEphemeralPub,
  })

  const ratchetState = await initRatchet(masterSecret)

  const responderState: RatchetState = {
    ...ratchetState,
    sendChainKey: ratchetState.recvChainKey,
    recvChainKey: ratchetState.sendChainKey,
  }
  await saveSession(conversationId, responderState)
}

// ─── Encrypt outbound ─────────────────────────────────────────────────────────

export async function encryptOutbound(
  plaintext: string,
  conversationId: string,
  myUsername?: string,
): Promise<Uint8Array> {
  let state = await loadSession(conversationId)
  if (!state) throw new Error(`No E2E session for ${conversationId}. Call initiateSession first.`)

  const { encrypted, nextState } = await encryptMessage(
    new TextEncoder().encode(plaintext),
    state,
  )
  await saveSession(conversationId, nextState)
  const packed = packEncryptedMessage(encrypted)

  const ephemPub = await getEphemeralPub(conversationId)
  if (ephemPub && myUsername) {
    const myPrivKey = await loadPrivateKey(myUsername)
    if (myPrivKey) {
      const myPub = myPrivKey.slice(32)
      const buf = new Uint8Array(1 + 32 + 32 + packed.length)
      buf[0] = 0x02
      buf.set(myPub, 1)
      buf.set(ephemPub, 33)
      buf.set(packed, 65)
      await _deleteEphemeralPub(conversationId)
      return buf
    }
  }

  const buf = new Uint8Array(1 + packed.length)
  buf[0] = 0x01
  buf.set(packed, 1)
  return buf
}

export async function decryptInbound(
  payload: Uint8Array,
  conversationId: string,
  myUsername?: string,
): Promise<string | null> {
  const type = payload[0]
  let packed = payload

  if (type === 0x02) {
    const senderIdentityPub = payload.slice(1, 33)
    const senderEphemeralPub = payload.slice(33, 65)
    packed = payload.slice(65)

    // Only run acceptSession if we have no session yet — never overwrite an
    // existing one (that would reset recvMsgNum and break the chain).
    const existing = await loadSession(conversationId)
    if (!existing && myUsername) {
      try {
        await acceptSession(myUsername, senderIdentityPub, senderEphemeralPub, conversationId, false)
      } catch (e) {
        console.error('acceptSession error:', e)
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
    // *** KEY FIX: only save the advanced ratchet state when decryption actually
    //     succeeded. crypto_secretbox_open_easy throws on bad MAC — so reaching
    //     this line means the decrypt was valid. Previously, the state was saved
    //     inside decryptMessage before the throw, permanently corrupting recvMsgNum.
    await saveSession(conversationId, nextState)
    return new TextDecoder().decode(plaintext)
  } catch {
    // Decryption failed — DO NOT save state. The ratchet position is unchanged.
    return null
  }
}

// ─── Ephemeral key storage (IndexedDB) ───────────────────────────────────────

const EPHEM_PREFIX = 'ephem:'

async function _storeEphemeralPub(conversationId: string, pub: Uint8Array): Promise<void> {
  const db = await sessionDB()
  await db.put(SESSION_STORE, { ephemeralKey: Array.from(pub) }, EPHEM_PREFIX + conversationId)
}

async function _deleteEphemeralPub(conversationId: string): Promise<void> {
  const db = await sessionDB()
  await db.delete(SESSION_STORE, EPHEM_PREFIX + conversationId)
}

export async function getEphemeralPub(conversationId: string): Promise<Uint8Array | undefined> {
  const db = await sessionDB()
  const raw = await db.get(SESSION_STORE, EPHEM_PREFIX + conversationId)
  if (!raw?.ephemeralKey) return undefined
  return new Uint8Array(raw.ephemeralKey as number[])
}