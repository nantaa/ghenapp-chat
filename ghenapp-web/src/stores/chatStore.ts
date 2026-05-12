import { create } from 'zustand'
import type { Conversation, Message } from '../types'
import { useAuthStore } from './authStore'

import { openDB } from 'idb'

// ─── IDB setup ────────────────────────────────────────────────────────────────
// Each message plaintext is stored as an individual row so writes are atomic
// (no full-blob replacement). Two stores:
//   'msg_id'   → key = `${conversationId}:${serverId}`  → plaintext
//   'msg_hash' → key = sha256(payload hex)               → `${conversationId}:${plain}`

const DB_NAME = 'ghenapp-msgcache'
const DB_VER  = 1

const dbReady = openDB(DB_NAME, DB_VER, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('msg_id'))   db.createObjectStore('msg_id')
    if (!db.objectStoreNames.contains('msg_hash')) db.createObjectStore('msg_hash')
  },
})

export const cacheReady: Promise<void> = dbReady.then(() => {})


// ─── SHA-256 helper ───────────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Memory caches (hot-path, populated from IDB on demand) ──────────────────
// msg_id cache: conversationId → { msgId → plaintext }
const idCache:   Record<string, Record<string, string>> = {}
// hash cache: sha256hex → `${conversationId}:${plain}`
const hashCache: Record<string, string> = {}

// Pre-warm memory caches from IDB at startup
export const warmCacheReady: Promise<void> = dbReady.then(async (d) => {
  // Iterate all msg_id entries
  const idCursor = await d.transaction('msg_id').store.openCursor()
  let cur = idCursor
  while (cur) {
    const [convId, msgId] = (cur.key as string).split(':')
    if (convId && msgId) {
      if (!idCache[convId]) idCache[convId] = {}
      idCache[convId][msgId] = cur.value as string
    }
    cur = await cur.continue()
  }
  // Iterate all msg_hash entries
  const hCursor = await d.transaction('msg_hash').store.openCursor()
  let hc = hCursor
  while (hc) {
    hashCache[hc.key as string] = hc.value as string
    hc = await hc.continue()
  }
})

// ─── Public cache API ─────────────────────────────────────────────────────────

/** Write plaintext keyed by server message ID (atomic per-row IDB put). */
export function cacheDecrypted(conversationId: string, msgId: string, text: string) {
  if (!idCache[conversationId]) idCache[conversationId] = {}
  idCache[conversationId][msgId] = text
  // Async atomic write — do not await
  dbReady.then(d => d.put('msg_id', text, `${conversationId}:${msgId}`)).catch(() => {})
}

/** Write plaintext keyed by sha256(payload) — for cross-session lookup. */
export async function cacheDecryptedByPayload(
  conversationId: string,
  payload: Uint8Array,
  text: string,
): Promise<void> {
  const h = await sha256Hex(payload)
  const val = `${conversationId}:${text}`
  hashCache[h] = val
  await dbReady.then(d => d.put('msg_hash', val, h)).catch(() => {})
}

/**
 * Re-key the ID cache from client-side snowflake to server-assigned ID.
 * Called from markDelivered when the server ACK arrives.
 */
export function rekeyCache(conversationId: string, clientId: string, serverId: string) {
  const conv = idCache[conversationId]
  if (!conv || clientId === serverId) return
  const text = conv[clientId]
  if (text == null) return
  conv[serverId] = text
  delete conv[clientId]
  dbReady.then(async d => {
    const tx = d.transaction('msg_id', 'readwrite')
    await tx.store.put(text, `${conversationId}:${serverId}`)
    await tx.store.delete(`${conversationId}:${clientId}`)
    await tx.done
  }).catch(() => {})
}

/** Synchronous lookup by message ID. */
export function getCachedDecrypted(conversationId: string, msgId: string): string | undefined {
  return idCache[conversationId]?.[msgId]
}

/** Async lookup: tries ID cache first, then hash cache. */
export async function getCachedDecryptedByPayload(
  conversationId: string,
  msgId: string,
  payload: Uint8Array,
): Promise<string | undefined> {
  // Wait for IDB warm-up on first call
  await warmCacheReady

  const byId = idCache[conversationId]?.[msgId]
  if (byId != null) return byId

  const h = await sha256Hex(payload)
  const entry = hashCache[h]
  if (entry != null) {
    // entry format: `${conversationId}:${plain}` — plain may contain colons
    const idx = entry.indexOf(':')
    const plain = idx >= 0 ? entry.slice(idx + 1) : entry
    // Promote to ID cache
    cacheDecrypted(conversationId, msgId, plain)
    return plain
  }
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
    if (msg.decryptedText) {
      cacheDecrypted(conversationId, msg.id, msg.decryptedText)
      if (msg.payload?.length) {
        cacheDecryptedByPayload(conversationId, msg.payload, msg.decryptedText).catch(() => {})
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
   * S-1: Accept an optional serverId. When present, re-key the plaintext
   * cache from the client-generated snowflake ID to the server-assigned ID.
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
    dbReady.then(async d => {
      await d.clear('msg_id')
      await d.clear('msg_hash')
    }).catch(() => {})
    set({ conversations: [], activeConversationId: null, messages: {} })
  },
}))
