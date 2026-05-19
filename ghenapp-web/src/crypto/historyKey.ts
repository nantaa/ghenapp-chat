/**
 * historyKey.ts — Per-conversation persistent history encryption
 *
 * Each user has a per-conversation history key derived deterministically from
 * their identity private key + conversation ID using BLAKE2b-based HKDF.
 * No key storage is needed on the server — any device with the identity key
 * can re-derive the history key and decrypt all their history blobs.
 *
 * Wire format of a history blob:
 *   [nonce: 24 bytes][XSalsa20-Poly1305 ciphertext]
 *
 * Security properties:
 * - Server stores opaque ciphertexts it cannot read
 * - Each user's blobs are independently encrypted (A can't read B's blobs)
 * - IMCP wire format is unchanged — this is a pure out-of-band archive layer
 */

import _sodium from 'libsodium-wrappers-sumo'
import { getIdentityKey } from '../ws/client'
import { loadPrivateKey } from './keygen'

let _ready = false
async function na() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── Key Derivation ───────────────────────────────────────────────────────────

/**
 * Derive the per-conversation history key for the current user.
 * Deterministic: re-derivable on any device that holds the identity private key.
 *
 * Formula (BLAKE2b-based HKDF):
 *   salt = BLAKE2b-32(conversationId)
 *   prk  = BLAKE2b-32(identityPrivKey, key=salt)
 *   hk   = BLAKE2b-32([info || 0x01], key=prk)
 *   where info = "ghenapp-history-v1"
 */
async function deriveHistoryKey(
  username: string,
  conversationId: string,
): Promise<Uint8Array> {
  // Resolve identity key: try in-memory cache first, then IDB.
  const identityKey = getIdentityKey() ?? (await loadPrivateKey(username))
  if (!identityKey) throw new Error('[historyKey] No identity key — cannot derive history key')

  // HKDF-SHA256 via Web Crypto API.
  // ikm  = identity private key (32 or 64 bytes)
  // salt = SHA-256 of conversationId (stable, unique per conversation)
  // info = "ghenapp-history-v1"
  const enc = new TextEncoder()
  const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode(conversationId))
  // Slice to a plain ArrayBuffer to satisfy BufferSource type constraint.
  const ikmBuf = identityKey.buffer.slice(identityKey.byteOffset, identityKey.byteOffset + identityKey.byteLength) as ArrayBuffer
  const ikmKey = await crypto.subtle.importKey('raw', ikmBuf, 'HKDF', false, ['deriveKey'])
  const hkKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBuf,
      info: enc.encode('ghenapp-history-v1'),
    },
    ikmKey,
    { name: 'AES-GCM', length: 256 },
    true,    // extractable so we can get the raw bytes
    ['encrypt', 'decrypt'],
  )
  const raw = await crypto.subtle.exportKey('raw', hkKey)
  return new Uint8Array(raw)
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext message for archival storage.
 * Returns a blob: [nonce:24][ciphertext:N].
 */
export async function encryptHistoryBlob(
  plaintext: string,
  username: string,
  conversationId: string,
): Promise<Uint8Array> {
  const s = await na()
  const key = await deriveHistoryKey(username, conversationId)
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES) // 24 bytes
  const ct = s.crypto_secretbox_easy(new TextEncoder().encode(plaintext), nonce, key)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce, 0)
  out.set(ct, nonce.length)
  return out
}

/**
 * Decrypt a history blob.
 * Returns null if the key cannot be derived (no identity key on device)
 * or if the blob is corrupted/forged.
 */
export async function decryptHistoryBlob(
  blob: Uint8Array,
  username: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const s = await na()
    const nonceLen = s.crypto_secretbox_NONCEBYTES // 24
    if (blob.length <= nonceLen) return null
    const key = await deriveHistoryKey(username, conversationId)
    const nonce = blob.slice(0, nonceLen)
    const ct = blob.slice(nonceLen)
    const pt = s.crypto_secretbox_open_easy(ct, nonce, key)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Decode a base64 history blob from the server REST response.
 * Returns null if the string is empty or invalid base64.
 */
export function decodeHistoryBlobBase64(b64: string | null | undefined): Uint8Array | null {
  if (!b64) return null
  try {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Encode a history blob to base64 for uploading to the server.
 */
export function encodeHistoryBlobBase64(blob: Uint8Array): string {
  return btoa(String.fromCharCode(...blob))
}
