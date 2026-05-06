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
} from './ratchet'
import { loadPrivateKey } from './keygen'

// ─── Session Initiation ───────────────────────────────────────────────────────

/**
 * Establish an outbound E2E session with `recipientUsername`.
 * Fetches their prekey bundle from the server, runs X3DH, and initialises
 * the Double Ratchet. Saves the session to IndexedDB.
 */
export async function initiateSession(
  myUsername: string,
  recipientUsername: string,
  conversationId: string,
): Promise<void> {
  // Check if session already exists
  const existing = await loadSession(conversationId)
  if (existing) return

  // Load our own private key
  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found — please register on this device first.')

  // Fetch recipient's prekey bundle
  const bundle = await api.getPrekeys(recipientUsername)
  if (!bundle) throw new Error('No prekey bundle available for recipient.')

  const recipientIdentityPub  = new Uint8Array(bundle.public_key)
  const recipientSignedPrekey = new Uint8Array(bundle.signed_prekey.public_key)
  const recipientOnetimePrekey = bundle.onetime_prekey
    ? new Uint8Array(bundle.onetime_prekey.public_key)
    : undefined

  // X3DH initiation
  const { masterSecret, ephemeralPublicKey } = await x3dhInitiate({
    senderIdentityPriv: myPrivKey,
    recipientIdentityPub,
    recipientSignedPrekeyPub: recipientSignedPrekey,
    recipientOnetimePrekeyPub: recipientOnetimePrekey,
  })

  // Initialise Double Ratchet
  const ratchetState = await initRatchet(masterSecret)

  // Persist session state and ephemeral public key (needed in first message header)
  await saveSession(conversationId, ratchetState)

  // Store ephemeral pub key so we can include it in the first message
  await _storeEphemeralPub(conversationId, ephemeralPublicKey)
}

/**
 * Accept an inbound session from a peer who sent us an ephemeral key.
 * Runs X3DH responder side and initialises the Double Ratchet.
 */
export async function acceptSession(
  myUsername: string,
  senderIdentityPub: Uint8Array,
  senderEphemeralPub: Uint8Array,
  conversationId: string,
  _usedOnetimePrekey: boolean,
): Promise<void> {
  const myPrivKey = await loadPrivateKey(myUsername)
  if (!myPrivKey) throw new Error('No local key found.')

  // For prototype: use same key as signed prekey (in production, store separately)
  const mySignedPrekeyPriv = myPrivKey

  const masterSecret = await x3dhRespond({
    recipientIdentityPriv: myPrivKey,
    recipientSignedPrekeyPriv: mySignedPrekeyPriv,
    senderIdentityPub,
    senderEphemeralPub,
  })

  const ratchetState = await initRatchet(masterSecret)
  await saveSession(conversationId, ratchetState)
}

// ─── Encrypt outbound ─────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext message for a conversation.
 * Returns the packed binary payload to put in the IMCP frame.
 */
export async function encryptOutbound(
  plaintext: string,
  conversationId: string,
): Promise<Uint8Array> {
  let state = await loadSession(conversationId)
  if (!state) throw new Error(`No E2E session for ${conversationId}. Call initiateSession first.`)

  const { encrypted, nextState } = await encryptMessage(
    new TextEncoder().encode(plaintext),
    state,
  )
  await saveSession(conversationId, nextState)
  return packEncryptedMessage(encrypted)
}

/**
 * Decrypt an inbound payload from an IMCP frame.
 * Returns the plaintext string, or null if decryption fails.
 */
export async function decryptInbound(
  payload: Uint8Array,
  conversationId: string,
): Promise<string | null> {
  const state = await loadSession(conversationId)
  if (!state) return null // no session yet — show as encrypted

  try {
    const encrypted = unpackEncryptedMessage(payload)
    const { plaintext, nextState } = await decryptMessage(encrypted, state)
    await saveSession(conversationId, nextState)
    return new TextDecoder().decode(plaintext)
  } catch {
    return null // bad decrypt — wrong key or corrupted
  }
}

// ─── Ephemeral key storage ────────────────────────────────────────────────────

const _ephemeralKeys = new Map<string, Uint8Array>()

async function _storeEphemeralPub(conversationId: string, pub: Uint8Array) {
  _ephemeralKeys.set(conversationId, pub)
}

export function getEphemeralPub(conversationId: string): Uint8Array | undefined {
  return _ephemeralKeys.get(conversationId)
}
