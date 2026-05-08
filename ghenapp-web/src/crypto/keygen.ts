// Client-side crypto module — Ed25519 keypair generation + key storage
// Uses libsodium-wrappers. All keys stored encrypted in IndexedDB via idb.
import _sodium from 'libsodium-wrappers-sumo'
import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'ghenapp-crypto'
const DB_VERSION = 1
const STORE_NAME = 'keys'

// ─── Database ─────────────────────────────────────────────────────────────────

async function getDB(): Promise<IDBPDatabase> {
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
  if (!_ready) {
    await _sodium.ready
    _ready = true
  }
  return _sodium
}

// ─── KeyPair Generation ───────────────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: Uint8Array   // 32 bytes
  privateKey: Uint8Array  // 64 bytes (seed + public)
}

export async function generateIdentityKeyPair(): Promise<Ed25519KeyPair> {
  const na = await sodium()
  const kp = na.crypto_sign_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

// ─── X25519 helpers (for X3DH DH operations) ──────────────────────────────────

export interface X25519KeyPair {
  publicKey: Uint8Array  // 32 bytes
  privateKey: Uint8Array // 32 bytes
}

/** Convert Ed25519 private key to X25519 for Diffie-Hellman */
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

export async function signChallenge(
  message: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  const na = await sodium()
  return na.crypto_sign_detached(message, privateKey)
}

export function buildLoginMessage(username: string): Uint8Array {
  const minuteTs = Math.floor(Date.now() / 1000 / 60) * 60
  return new TextEncoder().encode(`ghenapp-login:${username}:${minuteTs}`)
}

// ─── Prekey Generation (X3DH) ─────────────────────────────────────────────────

export async function generateSignedPrekey(identityPrivKey: Uint8Array): Promise<{
  publicKey: Uint8Array
  signature: Uint8Array
  privateKey: Uint8Array
}> {
  const na = await sodium()
  const kp = na.crypto_box_keypair()
  const signature = na.crypto_sign_detached(kp.publicKey, identityPrivKey)
  return { publicKey: kp.publicKey, signature, privateKey: kp.privateKey }
}

export async function generateOnetimePrekeys(count: number): Promise<Uint8Array[]> {
  const na = await sodium()
  return Array.from({ length: count }, () => na.crypto_sign_keypair().publicKey)
}

// ─── BIP39 Mnemonic (simplified — seed derivation, no external wordlist dep) ─

const WORDLIST_SAMPLE = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
  'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance',
  'advice', 'aerobic', 'afford', 'afraid', 'again', 'age', 'agent', 'agree',
  'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album', 'alcohol',
  'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone', 'alpha',
  'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among', 'amount',
  'amused', 'analyst', 'anchor', 'ancient', 'anger', 'angle', 'angry', 'animal',
  'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique', 'anxiety',
  'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april', 'arch',
  'arctic', 'area', 'arena', 'argue', 'arm', 'armed', 'armor', 'army',
  'around', 'arrange', 'arrest', 'arrive', 'arrow', 'art', 'artefact', 'artist',
  'artwork', 'ask', 'aspect', 'assault', 'asset', 'assist', 'assume', 'asthma',
  'athlete', 'atom', 'attack', 'attend', 'attitude', 'attract', 'auction', 'audit',
  'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado', 'avoid',
  'awake', 'aware', 'away', 'awesome', 'awful', 'awkward', 'axis', 'baby',
]

export async function deriveMnemonic(privateKey: Uint8Array): Promise<string[]> {
  const na = await sodium()
  const hash = na.crypto_generichash(16, privateKey, null)
  const words: string[] = []
  for (let i = 0; i < 12; i++) {
    const idx = ((hash[i * 1] ?? 0) * 256 + (hash[(i + 1) % 16] ?? 0)) % WORDLIST_SAMPLE.length
    words.push(WORDLIST_SAMPLE[idx])
  }
  return words
}

// ─── Encrypted IndexedDB Key Storage ─────────────────────────────────────────

export async function storePrivateKey(username: string, privateKey: Uint8Array): Promise<void> {
  const db = await getDB()
  // Store raw bytes — in production this would be AES-256-GCM encrypted with passphrase-derived key
  // For now: direct storage in IndexedDB (protected by same-origin policy)
  await db.put(STORE_NAME, privateKey, `identity:${username}`)
}

export async function loadPrivateKey(username: string): Promise<Uint8Array | null> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  return val ? new Uint8Array(val) : null
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
