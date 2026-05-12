import { create } from 'zustand'
import type { Conversation, Message } from '../types'
import { useAuthStore } from './authStore'

import { openDB } from 'idb'

// ─── IDB setup ────────────────────────────────────────────────────────────────
//
// Two object stores:
//   'msg_id'   → key = `${conversationId}:${msgId}`  → plaintext string
//   'msg_hash' → key = sha256hex(payload bytes)       → `${conversationId}:${plaintext}`
//
// VERSION POLICY: never delete stores on version bump — only add new ones.
// Deleting stores was the root cause of the "🔒 encrypted message" bug after
// every deploy. If we need to clear stale data in future, use a sweeper
// function keyed on creation timestamp rather than a destructive schema migration.
//
// DB_VER is now 3. The upgrade handler is purely additive.

const DB_NAME = 'ghenapp-msgcache'
const DB_VER = 3

const dbReady = openDB(DB_NAME, DB_VER, {
  upgrade(db, _oldVersion) {
    // Always additive — never delete existing stores
    if (!db.objectStoreNames.contains('msg_id')) {
      db.createObjectStore('msg_id')
    }
    if (!db.objectStoreNames.contains('msg_hash')) {
      db.createObjectStore('msg_hash')
    }
  },
  blocked() {
    console.warn('[CACHE] IDB upgrade blocked by another tab; data may be stale until that tab is closed')
  },
})

export const cacheReady: Promise<void> = dbReady.then(() => { })

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  )
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Memory caches ───────────────────────────────────────────────────────────
// Hot-path: populated from IDB on startup via warmCacheReady.
// idCache:   conversationId → { msgId → plaintext }
// hashCache: sha256hex       → `${conversationId}:${plaintext}`

const idCache: Record<string, Record<string, string>> = {}
const hashCache: Record<string, string> = {}

// Pre-warm memory caches from IDB at startup so first render hits memory, not IDB.
export const warmCacheReady: Promise<void> = dbReady.then(async (d) => {
  let idCount = 0, hashCount = 0

  const idCursor = await d.transaction('msg_id').store.openCursor()
  let cur = idCursor
  while (cur) {
    const key = cur.key as string
    const colon = key.indexOf(':')
    const convId = colon >= 0 ? key.slice(0, colon) : ''
    const msgId = colon >= 0 ? key.slice(colon + 1) : ''
    if (convId && msgId) {
      if (!idCache[convId]) idCache[convId] = {}
      idCache[convId][msgId] = cur.value as string
      idCount++
    }
    cur = await cur.continue()
  }

  const hCursor = await d.transaction('msg_hash').store.openCursor()
  let hc = hCursor
  while (hc) {
    hashCache[hc.key as string] = hc.value as string
    hashCount++
    hc = await hc.continue()
  }

  console.log(`[CACHE] warmCacheReady: loaded ${idCount} id-entries, ${hashCount} hash-entries`)
})

// ─── Public cache API ─────────────────────────────────────────────────────────

/**
 * Write plaintext keyed by server/client message ID.
 * Always writes both memory and IDB — never skip IDB for sent messages.
 */
export function cacheDecrypted(conversationId: string, msgId: string, text: string) {
  if (!idCache[conversationId]) idCache[conversationId] = {}
  idCache[conversationId][msgId] = text
  console.log(`[CACHE] write id-cache: conv=${conversationId.slice(0, 8)} msgId=${msgId} text="${text.slice(0, 20)}..."`)
  dbReady
    .then(d => d.put('msg_id', text, `${conversationId}:${msgId}`))
    .catch(e => console.error('[CACHE] IDB write failed (msg_id):', e))
}

/**
 * Write plaintext keyed by sha256(payload) — survives ID remapping.
 * This is the primary fallback for sent messages after a reload.
 */
export async function cacheDecryptedByPayload(
  conversationId: string,
  payload: Uint8Array,
  text: string,
): Promise<void> {
  if (!payload?.length) return
  const h = await sha256Hex(payload)
  const val = `${conversationId}:${text}`
  hashCache[h] = val
  await dbReady.then(d => d.put('msg_hash', val, h)).catch(() => { })
}

/**
 * Re-key the ID cache from client-side snowflake to server-assigned ID.
 * Called from markDelivered when the server ACK arrives.
 * Also writes the server ID into IDB so reloads find it.
 */
export function rekeyCache(conversationId: string, clientId: string, serverId: string) {
  if (clientId === serverId) return
  const conv = idCache[conversationId]
  if (!conv) return
  const text = conv[clientId]
  if (text == null) {
    console.warn(`[CACHE] rekeyCache MISS: clientId=${clientId} not in cache for conv=${conversationId.slice(0, 8)}`)
    return
  }
  console.log(`[CACHE] rekeyCache: ${clientId} → ${serverId} (conv=${conversationId.slice(0, 8)})`)
  conv[serverId] = text
  delete conv[clientId]

  dbReady
    .then(async d => {
      const tx = d.transaction('msg_id', 'readwrite')
      // Write server ID entry
      await tx.store.put(text, `${conversationId}:${serverId}`)
      // Remove old client ID entry
      await tx.store.delete(`${conversationId}:${clientId}`)
      await tx.done
      console.log(`[CACHE] IDB rekey done: ${clientId} → ${serverId}`)
    })
    .catch(e => console.error('[CACHE] IDB rekey failed:', e))
}

/** Synchronous lookup by message ID (memory only, call after warmCacheReady). */
export function getCachedDecrypted(conversationId: string, msgId: string): string | undefined {
  return idCache[conversationId]?.[msgId]
}

/**
 * Async lookup: tries ID cache first, then hash cache by payload.
 * Waits for IDB warm-up on first call so cold starts work correctly.
 *
 * For sent messages this is the ONLY way to recover plaintext after a reload —
 * we cannot re-decrypt our own outbound ciphertext because the ratchet state
 * is gone. So the hash cache must be populated at send time (see sendMessage
 * in ChatPage.tsx calling cacheDecryptedByPayload before await wsRef.send).
 */
export async function getCachedDecryptedByPayload(
  conversationId: string,
  msgId: string,
  payload: Uint8Array,
): Promise<string | undefined> {
  await warmCacheReady

  // Path 1: by message ID
  const byId = idCache[conversationId]?.[msgId]
  if (byId != null) {
    console.log(`[CACHE] HIT by-id: conv=${conversationId.slice(0, 8)} msgId=${msgId}`)
    return byId
  }

  // Path 2: by payload hash
  if (payload?.length) {
    const h = await sha256Hex(payload)
    const entry = hashCache[h]
    if (entry != null) {
      // entry format: `${conversationId}:${plain}` — plain may contain colons
      const idx = entry.indexOf(':')
      const plain = idx >= 0 ? entry.slice(idx + 1) : entry
      console.log(`[CACHE] HIT by-hash: conv=${conversationId.slice(0, 8)} msgId=${msgId}`)
      // Back-fill ID cache so next lookup is O(1)
      cacheDecrypted(conversationId, msgId, plain)
      return plain
    }
  }

  console.warn(`[CACHE] MISS: conv=${conversationId.slice(0, 8)} msgId=${msgId}`)
  return undefined
}

// ─── Zustand store ────────────────────────────────────────────────────────────

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Record<string, Message[]>
  setConversations: (convs: Conversation[]) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, msg: Message) => void
  setMessages: (conversationId: string, msgs: Message[]) => void
  markDelivered: (conversationId: string, msgId: string, serverId?: string) => void
  markSent: (conversationId: string, msgId: string) => void
  updateLastMessage: (conversationId: string, msg: Message) => void
  clearAll: () => void
}

export const useChatStore = create<ChatState>()((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},

  setConversations: (convs) => set({ conversations: convs }),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  addMessage: (conversationId, msg) => {
    // Persist plaintext immediately on add — both by ID and by payload hash.
    // This is critical for sent messages: we write under the client snowflake ID
    // here, then rekeyCache rewrites under the server ID when the ACK arrives.
    // The hash cache entry is the safety net if rekeyCache ever misses.
    if (msg.decryptedText) {
      cacheDecrypted(conversationId, msg.id, msg.decryptedText)
      if (msg.payload?.length) {
        cacheDecryptedByPayload(conversationId, msg.payload, msg.decryptedText).catch(() => { })
      }
    }

    set((state) => {
      const authState = useAuthStore.getState()
      const isMine =
        msg.senderId === authState.user?.id ||
        msg.senderId === authState.user?.username
      const isUnread = !isMine && state.activeConversationId !== conversationId

      const convs = state.conversations.map((c) => {
        if (c.id === conversationId) {
          return {
            ...c,
            lastMessage: msg,
            unreadCount: isUnread ? (c.unreadCount ?? 0) + 1 : (c.unreadCount ?? 0),
          }
        }
        return c
      })

      const targetConv = convs.find(c => c.id === conversationId)
      const sortedConvs = targetConv
        ? [targetConv, ...convs.filter(c => c.id !== conversationId)]
        : convs

      return {
        messages: {
          ...state.messages,
          [conversationId]: [...(state.messages[conversationId] ?? []), msg],
        },
        conversations: sortedConvs,
      }
    })
  },

  setMessages: (conversationId, msgs) =>
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
    })),

  /**
   * markDelivered: accept optional serverId.
   *
   * When serverId differs from msgId (client snowflake → server ID), we:
   *   1. Remap the plaintext cache entry under the new server ID
   *   2. Update the in-memory message with the new server ID and status
   *
   * After rekeyCache, the server ID is in both memory and IDB, so future
   * reloads find the plaintext via getCachedDecryptedByPayload path 1.
   */
  markDelivered: (conversationId, msgId, serverId) => {
    if (serverId && serverId !== msgId) {
      rekeyCache(conversationId, msgId, serverId)
    }
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).map((m) =>
          m.id === msgId
            ? { ...m, id: serverId ?? m.id, status: 'delivered' as const }
            : m,
        ),
      },
    }))
  },

  markSent: (conversationId, msgId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).map((m) =>
          m.id === msgId ? { ...m, status: 'sent' as const } : m,
        ),
      },
    })),

  updateLastMessage: (conversationId, msg) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, lastMessage: msg } : c,
      ),
    })),

  clearAll: () => {
    // Only clear in-memory state. IDB is left intact so the user's message
    // history survives explicit clearAll calls (e.g. logout on same device).
    // If you truly want to wipe IDB on logout, call clearIDBCache() separately.
    set({ conversations: [], activeConversationId: null, messages: {} })
  },
}))

/**
 * Explicitly clear IDB plaintext caches.
 * Call on logout if you want to remove cached plaintexts from the device.
 */
export async function clearIDBCache(): Promise<void> {
  const d = await dbReady
  await d.clear('msg_id')
  await d.clear('msg_hash')
  // Also clear memory caches
  Object.keys(idCache).forEach(k => delete idCache[k])
  Object.keys(hashCache).forEach(k => delete hashCache[k])
}