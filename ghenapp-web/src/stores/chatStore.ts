import { create } from 'zustand'
import type { Conversation, Message } from '../types'
import { useAuthStore } from './authStore'

import { openDB } from 'idb'

const STORAGE_KEY = 'ghen_msg_cache'
// Secondary index: sha256(payload hex) → plaintext, keyed per conversation
const HASH_STORAGE_KEY = 'ghen_msg_cache_hash'

// Memory caches for synchronous reads during React renders
const memCache: Record<string, Record<string, string>> = {}
const hashCache: Record<string, Record<string, string>> = {}

try {
  const lsRaw = localStorage.getItem(STORAGE_KEY)
  if (lsRaw) Object.assign(memCache, JSON.parse(lsRaw))
} catch {}

try {
  const lsRaw = localStorage.getItem(HASH_STORAGE_KEY)
  if (lsRaw) Object.assign(hashCache, JSON.parse(lsRaw))
} catch {}

const cacheDB = openDB('ghenapp-cache', 2, {
  upgrade(db, oldVersion) {
    if (!db.objectStoreNames.contains('msg_cache')) {
      db.createObjectStore('msg_cache')
    }
    if (!db.objectStoreNames.contains('hash_cache')) {
      db.createObjectStore('hash_cache')
    }
    // v1 → v2: nothing to migrate structurally, stores are created above
    void oldVersion
  },
})

export const cacheReady: Promise<void> = cacheDB.then(async (db) => {
  // Load ID cache
  const data = await db.get('msg_cache', STORAGE_KEY)
  if (data) {
    Object.assign(memCache, data)
  } else {
    try {
      const lsData = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (Object.keys(lsData).length > 0) {
        Object.assign(memCache, lsData)
        await db.put('msg_cache', memCache, STORAGE_KEY)
      }
    } catch {}
  }
  // Load hash cache
  const hData = await db.get('hash_cache', HASH_STORAGE_KEY)
  if (hData) Object.assign(hashCache, hData)
})

// ─── SHA-256 helper (Web Crypto, always available in browser) ─────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Persist helpers ──────────────────────────────────────────────────────────

function saveIdCache(cache: Record<string, Record<string, string>>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)) } catch {}
  cacheDB.then(db => db.put('msg_cache', cache, STORAGE_KEY))
}

function saveHashCache(cache: Record<string, Record<string, string>>) {
  try { localStorage.setItem(HASH_STORAGE_KEY, JSON.stringify(cache)) } catch {}
  cacheDB.then(db => db.put('hash_cache', cache, HASH_STORAGE_KEY))
}

// ─── Public cache API ─────────────────────────────────────────────────────────

/** Write plaintext under message ID (synchronous, also persists async). */
export function cacheDecrypted(conversationId: string, msgId: string, text: string) {
  if (!memCache[conversationId]) memCache[conversationId] = {}
  memCache[conversationId][msgId] = text
  saveIdCache(memCache)
}

/**
 * S-3: Write plaintext keyed by sha256(payload).
 * Call this whenever you cache a message so that server-history loads
 * (which use the server-assigned ID, not the client snowflake) can still
 * find the plaintext by matching the raw encrypted payload bytes.
 */
export async function cacheDecryptedByPayload(
  conversationId: string,
  payload: Uint8Array,
  text: string,
): Promise<void> {
  const h = await sha256Hex(payload)
  if (!hashCache[conversationId]) hashCache[conversationId] = {}
  hashCache[conversationId][h] = text
  saveHashCache(hashCache)
}

/**
 * S-1: Re-key the ID cache from an old (client-side) ID to the server-assigned ID.
 * Call this inside markDelivered when the ACK frame carries the authoritative server ID.
 */
export function rekeyCache(
  conversationId: string,
  clientId: string,
  serverId: string,
) {
  const conv = memCache[conversationId]
  if (!conv) return
  if (clientId === serverId) return
  const text = conv[clientId]
  if (text == null) return
  conv[serverId] = text
  delete conv[clientId]
  saveIdCache(memCache)
}

/** Look up plaintext by ID, with async payload-hash fallback. */
export function getCachedDecrypted(conversationId: string, msgId: string): string | undefined {
  return memCache[conversationId]?.[msgId]
}

/** Async variant that also checks the hash cache if ID lookup misses. */
export async function getCachedDecryptedByPayload(
  conversationId: string,
  msgId: string,
  payload: Uint8Array,
): Promise<string | undefined> {
  const byId = memCache[conversationId]?.[msgId]
  if (byId != null) return byId
  const h = await sha256Hex(payload)
  const byHash = hashCache[conversationId]?.[h]
  if (byHash != null) {
    // Opportunistically promote to ID cache so future lookups are O(1)
    cacheDecrypted(conversationId, msgId, byHash)
  }
  return byHash
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
    if (msg.decryptedText) {
      cacheDecrypted(conversationId, msg.id, msg.decryptedText)
      if (msg.payload?.length) {
        // Fire-and-forget hash cache write
        cacheDecryptedByPayload(conversationId, msg.payload, msg.decryptedText)
      }
    }
    set((state) => {
      const authState = useAuthStore.getState()
      const isMine = msg.senderId === authState.user?.id || msg.senderId === authState.user?.username
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
      let sortedConvs = convs
      if (targetConv) {
        sortedConvs = [targetConv, ...convs.filter(c => c.id !== conversationId)]
      }

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
   * S-1: Accept an optional serverId.  When present, re-key the plaintext
   * cache from the client-generated snowflake ID to the server-assigned ID
   * so that a subsequent history reload finds the cached plaintext.
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
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(HASH_STORAGE_KEY)
    set({ conversations: [], activeConversationId: null, messages: {} })
  },
}))
