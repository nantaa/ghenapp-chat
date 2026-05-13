// Client-side crypto module — Ed25519 keypair generation + key storage
// Uses libsodium-wrappers. Private keys stored AES-256-GCM encrypted in IndexedDB.
import _sodium from 'libsodium-wrappers-sumo'
import { openDB, type IDBPDatabase } from 'idb'

export const DB_NAME = 'ghenapp-crypto'
export const DB_VERSION = 2
export const STORE_NAME = 'keys'

// ─── Database ─────────────────────────────────────────────────────────────────

export async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    },
  })
}

// ─── Sodium init ──────────────────────────────────────────────────────────────

let _ready = false
async function sodium() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── KeyPair Generation ───────────────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: Uint8Array   // 32 bytes
  privateKey: Uint8Array  // 64 bytes (seed + public)
}

export async function generateIdentityKeyPair(seed?: Uint8Array): Promise<Ed25519KeyPair> {
  const na = await sodium()
  if (seed) {
    const kp = na.crypto_sign_seed_keypair(seed)
    return { publicKey: kp.publicKey, privateKey: kp.privateKey }
  }
  const kp = na.crypto_sign_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

// ─── X25519 helpers ───────────────────────────────────────────────────────────

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export async function ed25519ToX25519(ed25519Priv: Uint8Array): Promise<X25519KeyPair> {
  const na = await sodium()
  const x25519Priv = na.crypto_sign_ed25519_sk_to_curve25519(ed25519Priv)
  const x25519Pub = na.crypto_scalarmult_base(x25519Priv)
  return { publicKey: x25519Pub, privateKey: x25519Priv }
}

export async function generateX25519(): Promise<X25519KeyPair> {
  const na = await sodium()
  const kp = na.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export async function signChallenge(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  const na = await sodium()
  return na.crypto_sign_detached(message, privateKey)
}

export function buildLoginMessage(username: string): Uint8Array {
  const minuteTs = Math.floor(Date.now() / 1000 / 60) * 60
  return new TextEncoder().encode(`ghenapp-login:${username}:${minuteTs}`)
}

// ─── Prekey Generation ────────────────────────────────────────────────────────

export async function generateSignedPrekey(identityPrivKey: Uint8Array): Promise<{
  publicKey: Uint8Array; signature: Uint8Array; privateKey: Uint8Array
}> {
  const na = await sodium()
  const kp = na.crypto_box_keypair()
  const signature = na.crypto_sign_detached(kp.publicKey, identityPrivKey)
  return { publicKey: kp.publicKey, signature, privateKey: kp.privateKey }
}

export async function generateOnetimePrekeys(count: number): Promise<{
  publicKeys: Uint8Array[]; privateKeys: Uint8Array[]
}> {
  const na = await sodium()
  const pairs = Array.from({ length: count }, () => na.crypto_box_keypair())
  return { publicKeys: pairs.map((p) => p.publicKey), privateKeys: pairs.map((p) => p.privateKey) }
}

// ─── BIP-39 Mnemonic ──────────────────────────────────────────────────────────
import BIP39 from './bip39-english.json'

/** Generates a 12-word BIP-39 recovery phrase with checksum. */
export async function generateMnemonic(): Promise<string[]> {
  const entropy = crypto.getRandomValues(new Uint8Array(16))
  const hashBuffer = await crypto.subtle.digest('SHA-256', entropy)
  const hashArray = new Uint8Array(hashBuffer)
  
  let bits = ''
  for (let i = 0; i < 16; i++) {
    bits += entropy[i].toString(2).padStart(8, '0')
  }
  // Checksum is first 4 bits of SHA-256 hash
  const checksumBits = hashArray[0].toString(2).padStart(8, '0').slice(0, 4)
  bits += checksumBits
  
  const words: string[] = []
  for (let i = 0; i < 12; i++) {
    const chunk = bits.slice(i * 11, (i + 1) * 11)
    const index = parseInt(chunk, 2)
    const word = BIP39[index]
    if (!word) {
      console.error(`[crypto] BIP39 word missing at index ${index} for chunk ${chunk}`)
      words.push('UNKNOWN')
    } else {
      words.push(word)
    }
  }
  return words
}


export async function mnemonicToSeed(words: string[]): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(words.join(' ')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  )
  const seedBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode('mnemonic'),
      iterations: 2048,
      hash: 'SHA-512',
    },
    baseKey,
    256
  )
  return new Uint8Array(seedBuffer)
}

/** Reverse lookup: find the private key whose mnemonic matches the given words. */
export async function mnemonicToPrivKey(
  words: string[],
  _username: string,
): Promise<Uint8Array | null> {
  try {
    const seed = await mnemonicToSeed(words)
    const kp = await generateIdentityKeyPair(seed)
    return kp.privateKey
  } catch (err) {
    return null
  }
}

// ─── AES-256-GCM passphrase encryption (Wave 1A) ─────────────────────────────

const PBKDF2_ITERS = 100_000
const SALT_BYTES = 16
const IV_BYTES = 12

interface EncryptedBlob {
  v: 1
  salt: number[]
  iv: number[]
  ct: number[]
}

async function deriveAESKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptKey(passphrase: string, rawKey: Uint8Array): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv   = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const aesKey = await deriveAESKey(passphrase, salt)
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer
  const rawBuf = rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, aesKey, rawBuf)
  return { v: 1, salt: Array.from(salt), iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) }
}

async function decryptKey(passphrase: string, blob: EncryptedBlob): Promise<Uint8Array> {
  const salt = new Uint8Array(blob.salt)
  const iv   = new Uint8Array(blob.iv)
  const ct   = new Uint8Array(blob.ct)
  const aesKey = await deriveAESKey(passphrase, salt)
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer
  const ctBuf = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, aesKey, ctBuf)
  return new Uint8Array(pt)
}

// ─── Encrypted IndexedDB Key Storage ─────────────────────────────────────────

export async function storePrivateKey(
  username: string,
  privateKey: Uint8Array,
  passphrase?: string,
): Promise<void> {
  const db = await getDB()
  if (passphrase) {
    const blob = await encryptKey(passphrase, privateKey)
    await db.put(STORE_NAME, blob, `identity:${username}`)
  } else {
    await db.put(STORE_NAME, privateKey, `identity:${username}`)
  }
}

export async function loadPrivateKey(
  username: string,
  passphrase?: string,
): Promise<Uint8Array | null> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  if (!val) return null
  // Detect encrypted blob (has .v === 1)
  if (val && typeof val === 'object' && (val as any).v === 1) {
    if (!passphrase) throw new Error('Passphrase required to unlock this key.')
    try {
      return await decryptKey(passphrase, val as EncryptedBlob)
    } catch {
      throw new Error('Wrong passphrase — decryption failed.')
    }
  }
  return val instanceof Uint8Array ? val : new Uint8Array(val as any)
}

export async function isKeyEncrypted(username: string): Promise<boolean> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  return val != null && typeof val === 'object' && (val as any).v === 1
}

export async function deletePrivateKey(username: string): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_NAME, `identity:${username}`)
}

export async function hasStoredKey(username: string): Promise<boolean> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  return val != null
}

// ─── Sub-key storage (SPK, OPK) — always raw ─────────────────────────────────
// Only the identity key is passphrase-protected. Sub-keys use their own namespace.

export async function storeSubKey(label: string, key: Uint8Array): Promise<void> {
  const db = await getDB()
  await db.put(STORE_NAME, key, label)
}

export async function loadSubKey(label: string): Promise<Uint8Array | null> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, label)
  return val ? new Uint8Array(val as any) : null
}

// ─── TOFU — Trust On First Use (Wave 1C) ─────────────────────────────────────

const TOFU_PREFIX = 'tofu:'

export async function storeTrustedKey(username: string, pubKeyHex: string): Promise<void> {
  const db = await getDB()
  await db.put(STORE_NAME, pubKeyHex, TOFU_PREFIX + username)
}

export async function loadTrustedKey(username: string): Promise<string | null> {
  const db = await getDB()
  return (await db.get(STORE_NAME, TOFU_PREFIX + username)) ?? null
}

export async function checkKeyChange(
  username: string,
  newPubKeyHex: string,
): Promise<'new' | 'same' | 'changed'> {
  const trusted = await loadTrustedKey(username)
  if (!trusted) return 'new'
  return trusted === newPubKeyHex ? 'same' : 'changed'
}
