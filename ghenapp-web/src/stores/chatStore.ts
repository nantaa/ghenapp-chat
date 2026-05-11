import { create } from 'zustand'
import type { Conversation, Message } from '../types'
import { useAuthStore } from './authStore'

import { openDB } from 'idb'

const STORAGE_KEY = 'ghen_msg_cache'

// Memory cache for synchronous reads during React renders
const memCache: Record<string, Record<string, string>> = {}

// Pre-populate memCache synchronously from localStorage so reads on first
// render never race against the IndexedDB promise.
try {
  const lsRaw = localStorage.getItem(STORAGE_KEY)
  if (lsRaw) Object.assign(memCache, JSON.parse(lsRaw))
} catch {}

// IndexedDB initialization for persistent cache
const cacheDB = openDB('ghenapp-cache', 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('msg_cache')) {
      db.createObjectStore('msg_cache')
    }
  },
})

// cacheReady resolves once IndexedDB data has been merged into memCache.
// Await this before doing a cache-dependent history load.
export const cacheReady: Promise<void> = cacheDB.then(async (db) => {
  const data = await db.get('msg_cache', STORAGE_KEY)
  if (data) {
    Object.assign(memCache, data)
  } else {
    // Migrate from localStorage on first IndexedDB use
    try {
      const lsData = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (Object.keys(lsData).length > 0) {
        Object.assign(memCache, lsData)
        await db.put('msg_cache', memCache, STORAGE_KEY)
      }
    } catch {}
  }
})

function saveCache(cache: Record<string, Record<string, string>>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)) } catch {}
}

export function cacheDecrypted(conversationId: string, msgId: string, text: string) {
  if (!memCache[conversationId]) memCache[conversationId] = {}
  memCache[conversationId][msgId] = text

  // Persist to both for migration safety
  saveCache(memCache)
  cacheDB.then(db => db.put('msg_cache', memCache, STORAGE_KEY))
}

export function getCachedDecrypted(conversationId: string, msgId: string): string | undefined {
  return memCache[conversationId]?.[msgId]
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Record<string, Message[]>
  setConversations: (convs: Conversation[]) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, msg: Message) => void
  setMessages: (conversationId: string, msgs: Message[]) => void
  markDelivered: (conversationId: string, msgId: string) => void
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
    if (msg.decryptedText) cacheDecrypted(conversationId, msg.id, msg.decryptedText)
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
  markDelivered: (conversationId, msgId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).map((m) =>
          m.id === msgId ? { ...m, status: 'delivered' as const } : m,
        ),
      },
    })),
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
    set({ conversations: [], activeConversationId: null, messages: {} })
  },
}))
