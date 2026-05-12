import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Plus, Search, LogOut, Settings, MessageSquare, Wifi, WifiOff, Lock, Bell, BellOff, X
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import {
  useChatStore,
  getCachedDecryptedByPayload,
  cacheDecrypted,
  cacheDecryptedByPayload,
  warmCacheReady,
} from '../stores/chatStore'
import { GhenWSClient, encodeFrame, type DecodedFrame } from '../ws/client'
import * as api from '../lib/api'
import {
  initiateSession,
  encryptOutbound,
  decryptInboundStateless,
} from '../crypto/session'
import { loadSession } from '../crypto/ratchet'
import { getPushState, requestPushPermission, unsubscribePush, type PushManagerState } from '../push/push'
import type { Message, Conversation } from '../types'

type WSStatus = 'connected' | 'disconnected' | 'reconnecting'

export default function ChatPage() {
  const user = useAuthStore((s) => s.user)
  const clearUser = useAuthStore((s) => s.clearUser)
  const {
    conversations, activeConversationId,
    messages, setActiveConversation, addMessage, markSent, markDelivered,
  } = useChatStore()

  const [text, setText] = useState('')
  const [wsStatus, setWsStatus] = useState<WSStatus>('disconnected')
  const [search, setSearch] = useState('')
  const [sending, setSending] = useState(false)
  const [encError, setEncError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showNewDMModal, setShowNewDMModal] = useState(false)
  const [newDMUsername, setNewDMUsername] = useState('')
  const [newDMError, setNewDMError] = useState<string | null>(null)
  const [newDMSubmitting, setNewDMSubmitting] = useState(false)
  const [pushState, setPushState] = useState<PushManagerState>({ supported: false, permission: 'unsupported', subscribed: false })
  const wsRef = useRef<GhenWSClient | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ── WebSocket + E2E frame handler ────────────────────────────────────────────
  const handleFrame = useCallback(async (frame: DecodedFrame) => {
    if (!user) return

    const myId = user.id
    const myUsername = user.username

    // Helper: compare two Uint8Arrays by value
    function payloadMatches(a: Uint8Array, b: Uint8Array): boolean {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
      return true
    }

    const isMySend = (frame.senderId && myId && frame.senderId === myId) ||
      (frame.senderId && !myId && frame.senderId === myUsername)

    if (isMySend) {
      const allMessages = useChatStore.getState().messages[frame.conversationId] ?? []
      const serverId = frame.id.toString()

      // Match by payload bytes — this is the ONLY reliable way when multiple
      // messages are in-flight simultaneously. The server echoes back the exact
      // encrypted bytes we sent, so matching by payload is unambiguous.
      const inFlight = frame.payload?.length
        ? allMessages.find((m) =>
          (m.status === 'sending' || m.status === 'sent') &&
          m.payload?.length &&
          payloadMatches(m.payload, frame.payload)
        )
        : undefined

      // Fallback: if payload match fails (e.g. payload stripped), fall back to
      // the oldest in-flight message to prevent stale "sending" states.
      const matched = inFlight ?? allMessages.find((m) => m.status === 'sending' || m.status === 'sent')
      const clientId = matched?.id ?? serverId

      markDelivered(frame.conversationId, clientId, serverId)
      if (matched?.decryptedText) {
        cacheDecrypted(frame.conversationId, serverId, matched.decryptedText)
        if (matched.payload?.length) {
          cacheDecryptedByPayload(frame.conversationId, matched.payload, matched.decryptedText).catch(() => { })
        }
      }
      return
    }

    const storeMessages = useChatStore.getState().messages[frame.conversationId]
    const alreadyInStore = storeMessages?.some((m) => m.id === frame.id.toString())
    if (alreadyInStore) {
      markDelivered(frame.conversationId, frame.id.toString())
      return
    }

    const plain = await decryptInboundStateless(frame.payload, user.username)
    const decryptedText = plain ?? undefined

    if (plain && frame.id) {
      cacheDecrypted(frame.conversationId, frame.id.toString(), plain)
      cacheDecryptedByPayload(frame.conversationId, frame.payload, plain)
    }

    const existingConv = useChatStore.getState().conversations.find(
      (c) => c.id === frame.conversationId
    )
    if (!existingConv) {
      const convData = await api.getConversations().catch(() => null)
      const stillMissing = !useChatStore.getState().conversations.find(
        (c) => c.id === frame.conversationId
      )
      if (stillMissing) {
        const match = convData?.conversations.find((c: any) => c.id === frame.conversationId)
        const other = match?.members.find((m: any) => m.user_id !== user.id)
        const peerUsername = other?.username ?? ''
        const senderName = peerUsername || frame.conversationId.slice(0, 8)
        const conv: Conversation = {
          id: frame.conversationId,
          type: 'direct',
          participants: [user.id, other?.user_id ?? (frame.senderId || '')],
          unreadCount: 1,
          name: senderName,
          peerUsername,
        }
        useChatStore.getState().setConversations([
          ...useChatStore.getState().conversations,
          conv,
        ])
      }
    }

    const msg: Message = {
      id: frame.id.toString(),
      conversationId: frame.conversationId,
      senderId: frame.senderId || 'remote',
      payload: frame.payload,
      msgType: frame.msgType,
      timestampMs: frame.timestampMs,
      ttlSeconds: frame.ttlSeconds,
      decryptedText,
      status: 'delivered',
    }
    addMessage(frame.conversationId, msg)
  }, [addMessage, markDelivered, user])

  useEffect(() => {
    const token = localStorage.getItem('ghen_access_token')
    if (!token) return
    const client = new GhenWSClient(handleFrame, setWsStatus)
    client.connect(token, user?.username ?? '')
    wsRef.current = client
    return () => { client.disconnect(); wsRef.current = null }
  }, [handleFrame])

  useEffect(() => {
    if (!user) return
    api.getConversations()
      .then((data) => {
        const convs: Conversation[] = data.conversations.map((c: any) => {
          const otherMember = c.members.find((m: any) => m.user_id !== user.id)
          const peerUsername: string = otherMember?.username ?? ''
          const displayName = peerUsername || c.id.slice(0, 8)
          return {
            id: c.id,
            type: c.type as 'direct' | 'group',
            participants: c.members.map((m: any) => m.user_id),
            unreadCount: 0,
            name: displayName,
            peerUsername,
          }
        })
        const local = useChatStore.getState().conversations
        const serverIds = new Set(convs.map((c) => c.id))
        const merged = [...convs, ...local.filter((c) => !serverIds.has(c.id))]
        useChatStore.getState().setConversations(merged)
      })
      .catch((e) => console.warn('[ChatPage] getConversations failed:', e))
  }, [user])

  useEffect(() => {
    getPushState().then(setPushState)
  }, [])

  useEffect(() => {
    if (user && !user.id) {
      api.getUser(user.username).then(profile => {
        useAuthStore.getState().setUser({ ...user, id: profile.id })
      }).catch(console.error)
    }
  }, [user])

  // ── Load message history ────────────────────────────────────────────────────────────
  //
  // Priority order per message:
  //   1. ID cache hit (O(1), instant)
  //   2. Payload hash cache hit (S-3, handles client/server ID mismatch)
  //   3. Live decryptInbound() — works because every message now carries a
  //      full 0x02 X3DH header. Oldest-first so ratchet advances in order.
  //      Results written back to cache so next reload hits path 1/2.
  useEffect(() => {
    if (!activeConversationId || !user) return
    const existing = useChatStore.getState().messages[activeConversationId]
    if (existing && existing.length > 0) return

    warmCacheReady.then(() => api.getMessages(activeConversationId))
      .then(async (data) => {
        const parsedMsgs: Message[] = []
        const sorted = [...data.messages].sort((a, b) => a.timestamp_ms - b.timestamp_ms)

        console.log(`[HISTORY] loading ${sorted.length} msgs, conv=${activeConversationId?.slice(0, 8)}, user.id=${user.id}, user.username=${user.username}`)

        for (const m of sorted) {
          const rawPayload = new Uint8Array(m.payload)
          const isMine = m.sender_id === user.id || m.sender_id === user.username

          console.log(`[HISTORY] msg=${m.id} sender=${m.sender_id} isMine=${isMine} payloadLen=${rawPayload.length} payloadByte0=0x${rawPayload[0]?.toString(16)}`)

          // Path 1 + 2
          let plain: string | undefined = await getCachedDecryptedByPayload(
            m.conversation_id,
            m.id.toString(),
            rawPayload,
          ) ?? undefined

          // Path 3: live decrypt for peer messages only
          if (plain == null && !isMine) {
            plain = await decryptInboundStateless(rawPayload, user.username).catch(() => null) ?? undefined
            if (plain != null) {
              cacheDecrypted(m.conversation_id, m.id.toString(), plain)
              await cacheDecryptedByPayload(m.conversation_id, rawPayload, plain)
            }
          }

          parsedMsgs.push({
            id: m.id.toString(),
            conversationId: m.conversation_id,
            senderId: m.sender_id,
            payload: rawPayload,
            msgType: m.msg_type as Message['msgType'],
            timestampMs: m.timestamp_ms,
            decryptedText: plain,
            status: 'delivered' as const,
          })
        }

        parsedMsgs.sort((a, b) => a.timestampMs - b.timestampMs)

        const current = useChatStore.getState().messages[activeConversationId] ?? []
        const existingIds = new Set(current.map((x) => x.id))
        const fresh = parsedMsgs.filter((m) => !existingIds.has(m.id))
        if (fresh.length > 0) {
          useChatStore.getState().setMessages(activeConversationId, [...fresh, ...current])
        }
      })
      .catch((e) => console.warn('[ChatPage] getMessages failed:', e))
  }, [activeConversationId, user])

  async function togglePush() {
    const token = localStorage.getItem('ghen_access_token')
    if (!token) return
    if (pushState.subscribed) {
      await unsubscribePush(token)
    } else {
      await requestPushPermission(token)
    }
    getPushState().then(setPushState)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeConversationId])

  // ── Send E2E message ─────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!text.trim() || !activeConversationId || !wsRef.current || !user) return

    setSending(true)
    setEncError(null)

    try {
      const activeConv = useChatStore.getState().conversations.find(
        (c) => c.id === activeConversationId,
      )
      if (!activeConv) throw new Error('No active conversation selected')

      const targetUsername = activeConv.peerUsername?.trim().toLowerCase()
      if (!targetUsername) {
        throw new Error('Cannot determine peer username — try closing and reopening the conversation.')
      }

      const existing = await loadSession(activeConversationId)
      if (!existing) {
        await initiateSession(user.username, targetUsername, activeConversationId)
      }

      const payload = await encryptOutbound(text.trim(), activeConversationId, user.username)

      const EPOCH = 1700000000000n
      const msgId = (BigInt(Date.now()) - EPOCH) << 22n | BigInt(Math.floor(Math.random() * (1 << 22)))

      const frame = encodeFrame({ msgType: 'TEXT', id: msgId, conversationId: activeConversationId, payload })

      const plaintext = text.trim()
      const msg: Message = {
        id: msgId.toString(),
        conversationId: activeConversationId,
        senderId: user.id,
        payload,
        msgType: 'TEXT',
        timestampMs: Date.now(),
        decryptedText: plaintext,
        status: 'sending',
      }

      addMessage(activeConversationId, msg)
      cacheDecrypted(activeConversationId, msgId.toString(), plaintext)
      await cacheDecryptedByPayload(activeConversationId, payload, plaintext)

      setText('')
      await wsRef.current.send(frame)
      markSent(activeConversationId, msgId.toString())
    } catch (err: any) {
      console.error('sendMessage failed:', err)
      setEncError(err?.message ?? 'Encryption failed — session not established?')
    } finally {
      setSending(false)
    }
  }

  // ── Reset session ──────────────────────────────────────────────────────────────
  async function resetSession() {
    if (!activeConversationId || !user) return
    const { deleteSession } = await import('../crypto/ratchet')
    await deleteSession(activeConversationId)
    const activeConv = useChatStore.getState().conversations.find(c => c.id === activeConversationId)
    const target = activeConv?.peerUsername
    if (target) {
      await initiateSession(user.username, target, activeConversationId, true)
        .catch(e => console.error('Reset failed:', e))
    }
    useChatStore.getState().setMessages(activeConversationId, [])
    setShowSettings(false)
  }

  // ── New DM ─────────────────────────────────────────────────────────────────
  async function handleNewDM() {
    const target = newDMUsername.trim().toLowerCase()
    if (!target || !user) return
    setNewDMSubmitting(true)
    setNewDMError(null)

    try {
      const bundle = await api.getPrekeys(target) as any
      if (!bundle || bundle.error) throw new Error(bundle?.error || 'User not found')
      if (!bundle.user_id) throw new Error('Invalid user data from server')

      const result = await api.createDM(bundle.user_id) as any
      if (!result?.conversation_id) throw new Error('Failed to create conversation')

      const conversationId = result.conversation_id
      await initiateSession(user.username, target, conversationId)

      const newConv: Conversation = {
        id: conversationId,
        type: 'direct',
        participants: [user.id, bundle.user_id],
        unreadCount: 0,
        name: bundle.username || target,
        peerUsername: target,
      }

      useChatStore.getState().setConversations([
        newConv,
        ...useChatStore.getState().conversations.filter(c => c.id !== conversationId),
      ])
      setActiveConversation(conversationId)
      setShowNewDMModal(false)
      setNewDMUsername('')
    } catch (err: any) {
      setNewDMError(err?.message ?? 'Failed to start conversation')
    } finally {
      setNewDMSubmitting(false)
    }
  }

  const filteredConvs = conversations.filter((c) =>
    c.name?.toLowerCase().includes(search.toLowerCase())
  )

  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const activeMessages = activeConversationId ? (messages[activeConversationId] ?? []) : []

  function formatTime(ms: number) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="chat-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="app-name">GhenApp</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="icon-btn" title="New conversation" onClick={() => setShowNewDMModal(true)}>
              <Plus size={18} />
            </button>
            <button
              className="icon-btn" title="Sign out"
              onClick={() => { clearUser(); localStorage.removeItem('ghen_access_token') }}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="user-row">
          <span className="username">@{user?.username}</span>
          <span className={`ws-badge ${wsStatus}`}>
            {wsStatus === 'connected'
              ? <><Wifi size={12} /> connected</>
              : wsStatus === 'reconnecting'
                ? <><WifiOff size={12} /> reconnecting</>
                : <><WifiOff size={12} /> disconnected</>}
          </span>
        </div>

        <div className="search-wrap">
          <Search size={14} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <ul className="conv-list" role="list">
          {filteredConvs.map((conv) => (
            <li
              key={conv.id}
              className={`conv-item ${conv.id === activeConversationId ? 'active' : ''}`}
              onClick={async () => {
                setActiveConversation(conv.id)
                const { loadSession } = await import('../crypto/ratchet')
                const existing = await loadSession(conv.id)
                if (!existing && user) {
                  const otherUsername = conv.peerUsername || null
                  if (otherUsername) {
                    await initiateSession(user.username, otherUsername, conv.id).catch(() => { })
                  }
                }
              }}
            >
              <div className="conv-avatar">
                {(conv.name ?? conv.id)[0].toUpperCase()}
              </div>
              <div className="conv-meta">
                <span className="conv-name">{conv.name ?? conv.id.slice(0, 8)}</span>
                <span className="conv-sub"><Lock size={10} /> encrypted</span>
              </div>
              {(conv.unreadCount ?? 0) > 0 && (
                <span className="unread-badge">{conv.unreadCount}</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Main chat area ── */}
      <main className="chat-main">
        {activeConv ? (
          <>
            <header className="chat-header">
              <div className="chat-header-info">
                <div className="conv-avatar sm">{(activeConv.name ?? activeConv.id)[0].toUpperCase()}</div>
                <div>
                  <div className="chat-peer-name">{activeConv.name}</div>
                  <div className="chat-e2e-badge"><Lock size={11} /> end-to-end encrypted</div>
                </div>
              </div>
              <button className="icon-btn" onClick={() => setShowSettings(s => !s)}>
                <Settings size={18} />
              </button>
            </header>

            {showSettings && (
              <div className="settings-panel">
                <button className="btn btn-ghost" style={{ width: '100%' }} onClick={resetSession}>
                  🔄 Reset secure session
                </button>
                <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={togglePush}>
                  {pushState.subscribed
                    ? <><BellOff size={14} /> Disable notifications</>
                    : <><Bell size={14} /> Enable notifications</>}
                </button>
              </div>
            )}

            <div className="messages-wrap">
              {activeMessages.map((msg) => {
                const isMine = msg.senderId === user?.id || msg.senderId === user?.username
                return (
                  <div key={msg.id} className={`msg-row ${isMine ? 'mine' : 'theirs'}`}>
                    <div className={`msg-bubble ${isMine ? 'mine' : 'theirs'}`}>
                      {msg.decryptedText != null
                        ? msg.decryptedText
                        : <span className="msg-encrypted">🔒 encrypted message</span>
                      }
                      <div className="msg-meta">
                        <span className="msg-time">{formatTime(msg.timestampMs)}</span>
                        {isMine && (
                          <span className="msg-status">
                            {msg.status === 'sending' ? '·' : msg.status === 'sent' ? '✓' : '✓ delivered'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            {encError && (
              <div className="enc-error">
                <span>{encError}</span>
                <button className="icon-btn" onClick={() => setEncError(null)}><X size={14} /></button>
              </div>
            )}

            <div className="input-bar">
              <textarea
                className="msg-input"
                placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
                rows={1}
              />
              <button className="send-btn" onClick={sendMessage} disabled={sending || !text.trim()}>
                <Send size={18} />
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <MessageSquare size={48} className="empty-icon" />
            <p>No conversation selected</p>
            <p className="empty-sub">Pick one from the sidebar or start a new chat.</p>
            <button className="btn btn-primary" onClick={() => setShowNewDMModal(true)}>
              <Plus size={16} /> New Conversation
            </button>
          </div>
        )}
      </main>

      {/* ── New DM modal ── */}
      {showNewDMModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowNewDMModal(false) }}>
          <div className="modal">
            <div className="modal-header">
              <h2>New Conversation</h2>
              <button className="icon-btn" onClick={() => setShowNewDMModal(false)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <label className="form-label">Username</label>
              <input
                className="form-input"
                placeholder="Enter username..."
                value={newDMUsername}
                onChange={(e) => setNewDMUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleNewDM() }}
                autoFocus
              />
              {newDMError && <p className="form-error">{newDMError}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowNewDMModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleNewDM}
                disabled={newDMSubmitting || !newDMUsername.trim()}
              >
                {newDMSubmitting ? 'Starting...' : 'Start Chat'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
