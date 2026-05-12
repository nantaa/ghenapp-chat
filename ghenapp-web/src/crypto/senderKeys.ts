import sodium from 'libsodium-wrappers-sumo'
import { getDB, STORE_NAME } from './keygen'

// Generate a random 32-byte symmetric Sender Key
export async function generateSenderKey(): Promise<Uint8Array> {
  await sodium.ready
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)
}

// Encrypt a group message using the sender's Sender Key
export async function encryptGroupMessage(plaintext: string, senderKey: Uint8Array): Promise<Uint8Array> {
  await sodium.ready
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const messageBytes = new TextEncoder().encode(plaintext)
  const ciphertext = sodium.crypto_secretbox_easy(messageBytes, nonce, senderKey)
  
  // Package nonce + ciphertext together
  const payload = new Uint8Array(nonce.length + ciphertext.length)
  payload.set(nonce, 0)
  payload.set(ciphertext, nonce.length)
  return payload
}

// Decrypt a group message using the sender's Sender Key
export async function decryptGroupMessage(payload: Uint8Array, senderKey: Uint8Array): Promise<string | null> {
  await sodium.ready
  if (payload.length <= sodium.crypto_secretbox_NONCEBYTES) return null
  
  const nonce = payload.slice(0, sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = payload.slice(sodium.crypto_secretbox_NONCEBYTES)
  
  try {
    const decryptedBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, senderKey)
    return new TextDecoder().decode(decryptedBytes)
  } catch {
    return null
  }
}

// Store a peer's Sender Key for a specific group
export async function storeGroupSenderKey(groupId: string, senderUsername: string, senderKey: Uint8Array): Promise<void> {
  const db = await getDB()
  const keyLabel = `group-key:${groupId}:${senderUsername}`
  await db.put(STORE_NAME, senderKey, keyLabel)
}

// Load a peer's Sender Key for a specific group
export async function loadGroupSenderKey(groupId: string, senderUsername: string): Promise<Uint8Array | null> {
  const db = await getDB()
  const keyLabel = `group-key:${groupId}:${senderUsername}`
  const val = await db.get(STORE_NAME, keyLabel)
  return val ? new Uint8Array(val as number[]) : null
}

// Load or generate my own Sender Key for a specific group
export async function getMyGroupSenderKey(groupId: string, myUsername: string): Promise<Uint8Array> {
  let key = await loadGroupSenderKey(groupId, myUsername)
  if (!key) {
    key = await generateSenderKey()
    await storeGroupSenderKey(groupId, myUsername, key)
  }
  return key
}
