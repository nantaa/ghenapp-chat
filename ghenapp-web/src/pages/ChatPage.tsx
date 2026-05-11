import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Plus, Search, LogOut, Settings, MessageSquare, Users, Wifi, WifiOff, Lock, Bell, BellOff, X
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useChatStore, getCachedDecrypted, cacheDecrypted } from '../stores/chatStore'
import { GhenWSClient, encodeFrame, type DecodedFrame } from '../ws/client'
import * as api from '../lib/api'
import { initiateSession, encryptOutbound, decryptInbound } from '../crypto/session'
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

    // ── GUARD: skip echoes of our own sent messages ──────────────────────────
    // FIX: Check both user.id and user.username to handle missing-id edge case
    const myId = user.id
    const myUsername = user.username
    if (frame.senderId && myId && frame.senderId === myId) {
      markDelivered(frame.conversationId, frame.id.toString())
      return
    }
    if (frame.senderId && !myId && frame.senderId === myUsername) {
      markDelivered(frame.conversationId, frame.id.toString())
      return
    }
    // Binary frames have no senderId — detect echo by checking the store
    const storeMessages = useChatStore.getState().messages[frame.conversationId]
    const alreadyInStore = storeMessages?.some((m) => m.id === frame.id.toString())
    if (alreadyInStore) {
      markDelivered(frame.conversationId, frame.id.toString())
      return
    }

    // ── Decrypt inbound (live — advances ratchet) ────────────────────────────
    const plain = await decryptInbound(frame.payload, frame.conversationId, user.username)
    const decryptedText = plain ?? undefined

    // ── Ensure conversation appears in sidebar ───────────────────────────────
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
        // FIX: store peerUsername separately from display name
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
    const token = sessionStorage.getItem('ghen_access_token')
    if (!token) return
    const client = new GhenWSClient(handleFrame, setWsStatus)
    client.connect(token, user?.username ?? '')
    wsRef.current = client
    return () => { client.disconnect(); wsRef.current = null }
  }, [handleFrame])

  // ── Load conversation list from server on mount ───────────────────────────────
  useEffect(() => {
    if (!user) return
    api.getConversations()
      .then((data) => {
        const convs: Conversation[] = data.conversations.map((c: any) => {
          const otherMember = c.members.find((m: any) => m.user_id !== user.id)
          // FIX: peerUsername is the server-verified username, name is display fallback
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

  // ── Push state sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    getPushState().then(setPushState)
  }, [])

  // ── Repair missing user ID (migration for older registrations) ──────────────
  useEffect(() => {
    if (user && !user.id) {
      api.getUser(user.username).then(profile => {
        useAuthStore.getState().setUser({ ...user, id: profile.id })
      }).catch(console.error)
    }
  }, [user])

  // ── Load message history when conversation is opened ─────────────────────────
  useEffect(() => {
    if (!activeConversationId || !user) return
    const existing = useChatStore.getState().messages[activeConversationId]
    if (existing && existing.length > 0) return
    api.getMessages(activeConversationId)
      .then(async (data) => {
        const parsedMsgs: Message[] = []

        for (const m of data.messages) {
          const rawPayload = new Uint8Array(m.payload)
          // FIX: For history, ONLY use the localStorage cache. Do NOT call
          // decryptInbound here — it would advance the live ratchet recvMsgNum
          // counter, causing all subsequent live messages to fail decryption.
          // The cache is written when messages are first received live.
          let plain = getCachedDecrypted(m.conversation_id, m.id.toString())

          // Best-effort: if cache misses for our own sent messages, we already
          // know the plaintext was cached at send time. For incoming messages
          // with no cache, show encrypted placeholder — the user will need to
          // be online when messages arrive to decrypt them.
          // We deliberately do NOT call decryptInbound here.

          parsedMsgs.push({
            id: m.id.toString(),
            conversationId: m.conversation_id,
            senderId: m.sender_id,
            payload: rawPayload,
            msgType: m.msg_type as Message['msgType'],
            timestampMs: m.timestamp_ms,
            decryptedText: plain ?? undefined,
            status: 'delivered' as const,
          })
        }

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
    const token = sessionStorage.getItem('ghen_access_token')
    if (!token) return
    if (pushState.subscribed) {
      await unsubscribePush(token)
    } else {
      await requestPushPermission(token)
    }
    getPushState().then(setPushState)
  }

  // ── Auto-scroll ──────────────────────────────────────────────────────────────
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

      if (!activeConv) {
        throw new Error('No active conversation selected')
      }

      // FIX: Use peerUsername (guaranteed correct) not conv.name (may be UUID slice)
      const targetUsername = activeConv.peerUsername?.trim().toLowerCase()
      if (!targetUsername) {
        throw new Error('Cannot determine peer username — try closing and reopening the conversation.')
      }

      const existing = await loadSession(activeConversationId)
      if (!existing) {
        await initiateSession(
          user.username,
          targetUsername,
          activeConversationId,
        )
      }

      const payload = await encryptOutbound(
        text.trim(),
        activeConversationId,
        user.username,
      )

      const randomBits = Math.floor(Math.random() * 100000);
      const msgId = BigInt(Date.now()) * 100000n + BigInt(randomBits);
      const frame = encodeFrame({
        msgType: 'TEXT',
        id: msgId,
        conversationId: activeConversationId,
        payload,
      })

      const msg: Message = {
        id: msgId.toString(),
        conversationId: activeConversationId,
        senderId: user.id,
        payload,
        msgType: 'TEXT',
        timestampMs: Date.now(),
        decryptedText: text.trim(),
        status: 'sending',
      }

      addMessage(activeConversationId, msg)
      cacheDecrypted(activeConversationId, msgId.toString(), text.trim())
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

  // ── New DM — initiates X3DH session ─────────────────────────────────────────
  async function submitNewDM() {
    if (!newDMUsername?.trim() || !user) return
    const target = newDMUsername.trim().toLowerCase()
    setNewDMSubmitting(true)
    setNewDMError(null)
    try {
      const bundle = await api.getPrekeys(target) as any
      if (!bundle || bundle.error) {
        throw new Error(bundle?.error || 'User not found')
      }
      if (!bundle.user_id) {
        throw new Error('Invalid user data from server')
      }

      const dmRes = await api.createDM(bundle.user_id) as any
      if (!dmRes || dmRes.error) {
        throw new Error(dmRes?.error || 'Failed to create DM')
      }

      const convId = dmRes.conversation_id
      await initiateSession(user.username, target, convId)

      const conv: Conversation = {
        id: convId,
        type: 'direct',
        participants: [user.id, bundle.user_id],
        unreadCount: 0,
        name: bundle.username || target,
        // FIX: store peerUsername explicitly
        peerUsername: bundle.username || target,
      }
      useChatStore.getState().setConversations([
        ...useChatStore.getState().conversations, conv,
      ])
      setActiveConversation(convId)
      setShowNewDMModal(false)
      setNewDMUsername('')
    } catch (err: any) {
      console.error('New DM failed:', err)
      setNewDMError(err.message)
    } finally {
      setNewDMSubmitting(false)
    }
  }

  // ── Logout ───────────────────────────────────────────────────────────────────
  async function handleLogout() {
    const rt = localStorage.getItem('ghen_refresh_token')
    if (rt) await api.logout(rt).catch(() => { })
    api.clearTokens()
    clearUser()
    setTimeout(() => {
      window.location.href = '/login'
    }, 50)
  }

  // ── Derived state ────────────────────────────────────────────────────────────
  const activeMessages = activeConversationId ? (messages[activeConversationId] ?? []) : []
  const filteredConvs = conversations.filter((c) =>
    (c.name ?? '').toLowerCase().includes(search.toLowerCase()),
  )
  const activeConv = conversations.find((c) => c.id === activeConversationId)

  return (
    <div className="app-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-logo">GhenApp</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setShowNewDMModal(true); setTimeout(() => document.getElementById('new-dm-input')?.focus(), 50) }} className="btn btn-ghost" style={{ padding: '6px 10px' }} title="New conversation">
              <Plus size={16} />
            </button>
            <button onClick={handleLogout} className="btn btn-ghost" style={{ padding: '6px 10px' }} title="Log out">
              <LogOut size={16} />
            </button>
          </div>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>@{user?.username}</span>
          <span className={`ws-badge ${wsStatus}`}>
            {wsStatus === 'connected' ? <Wifi size={10} /> : <WifiOff size={10} />}
            {wsStatus}
          </span>
        </div>

        <div className="sidebar-search">
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              className="input"
              placeholder="Search conversations…"
              style={{ paddingLeft: 36, fontSize: 13 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="sidebar-list">
          {filteredConvs.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No conversations yet.<br />
              <button onClick={() => { setShowNewDMModal(true); setTimeout(() => document.getElementById('new-dm-input')?.focus(), 50) }} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 8, fontSize: 13 }}>
                Start one →
              </button>
            </div>
          )}
          {filteredConvs.map((conv) => (
            <div
              key={conv.id}
              className={`conv-item ${activeConversationId === conv.id ? 'active' : ''}`}
              onClick={async () => {
                setActiveConversation(conv.id)
                // Auto-initiate session if none exists for this conversation
                // FIX: use peerUsername not conv.name
                try {
                  const { loadSession } = await import('../crypto/ratchet')
                  const existing = await loadSession(conv.id)
                  if (!existing && user) {
                    const targetUsername = conv.peerUsername?.trim().toLowerCase()
                    if (targetUsername) {
                      await initiateSession(user.username, targetUsername, conv.id).catch((e) => {
                        console.warn('[ChatPage] Auto-init session failed:', e)
                      })
                    }
                  }
                } catch (e) {
                  console.warn('[ChatPage] loadSession check failed:', e)
                }
              }}
            >
              <div className="conv-avatar">
                {(conv.name ?? conv.id).slice(0, 1).toUpperCase()}
              </div>
              <div className="conv-info">
                <div className="conv-name">{conv.name ?? conv.id.slice(0, 8)}</div>
                <div className="conv-preview">
                  <Lock size={10} style={{ display: 'inline', marginRight: 3 }} />
                  encrypted
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main chat area ── */}
      <main className="chat-main">
        {!activeConversationId ? (
          <div className="empty-chat">
            <MessageSquare size={48} style={{ color: 'var(--text-faint)', marginBottom: 16 }} />
            <p style={{ color: 'var(--text-muted)' }}>No conversation selected</p>
            <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>Pick one from the sidebar or start a new chat.</p>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => { setShowNewDMModal(true); setTimeout(() => document.getElementById('new-dm-input')?.focus(), 50) }}
            >
              <Plus size={14} /> New Conversation
            </button>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="conv-avatar" style={{ width: 36, height: 36, fontSize: 14 }}>
                  {(activeConv?.name ?? activeConversationId).slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{activeConv?.name ?? activeConversationId.slice(0, 8)}</div>
                  <div style={{ fontSize: 11, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Lock size={10} /> end-to-end encrypted
                  </div>
                </div>
              </div>
              <button className="btn btn-ghost" style={{ padding: '6px 10px' }} onClick={() => setShowSettings(true)}>
                <Settings size={16} />
              </button>
            </div>

            <div className="chat-messages">
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
                        {new Date(msg.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {isMine && (
                          <span className="msg-status">
                            {msg.status === 'sending' ? ' · sending' : msg.status === 'sent' ? ' · sent' : msg.status === 'delivered' ? ' · delivered' : ' · failed'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {encError && (
                <div style={{ padding: '8px 16px', color: 'var(--error)', fontSize: 12, textAlign: 'center' }}>
                  ⚠️ {encError}
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="chat-input-bar">
              <textarea
                className="input chat-textarea"
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
                style={{ resize: 'none', flex: 1 }}
              />
              <button
                className="btn btn-primary"
                style={{ padding: '10px 14px', alignSelf: 'flex-end' }}
                onClick={sendMessage}
                disabled={sending || !text.trim()}
              >
                <Send size={16} />
              </button>
            </div>
          </>
        )}
      </main>

      {/* ── New DM Modal ── */}
      {showNewDMModal && (
        <div className="modal-overlay" onClick={() => setShowNewDMModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>New Conversation</h3>
              <button className="btn btn-ghost" onClick={() => setShowNewDMModal(false)} style={{ padding: 4 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Username</label>
              <input
                id="new-dm-input"
                className="input"
                placeholder="Enter username…"
                value={newDMUsername}
                onChange={(e) => setNewDMUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitNewDM()}
                autoComplete="off"
              />
            </div>
            {newDMError && (
              <div style={{ fontSize: 12, color: 'var(--error)', marginBottom: 10 }}>{newDMError}</div>
            )}
            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              onClick={submitNewDM}
              disabled={newDMSubmitting || !newDMUsername.trim()}
            >
              {newDMSubmitting ? 'Setting up secure channel…' : 'Start Encrypted Chat'}
            </button>
          </div>
        </div>
      )}

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Settings</h3>
              <button className="btn btn-ghost" onClick={() => setShowSettings(false)} style={{ padding: 4 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>Logged in as</div>
              <div style={{ fontWeight: 600 }}>@{user?.username}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Push Notifications</div>
              <button
                className={`btn ${pushState.subscribed ? 'btn-ghost' : 'btn-primary'}`}
                style={{ width: '100%', gap: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={togglePush}
                disabled={!pushState.supported || pushState.permission === 'denied'}
              >
                {pushState.subscribed ? <><BellOff size={14} /> Disable notifications</> : <><Bell size={14} /> Enable notifications</>}
              </button>
              {pushState.permission === 'denied' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Notifications blocked by browser. Allow in browser settings.</div>
              )}
            </div>
            <button
              className="btn btn-ghost"
              style={{ width: '100%', color: 'var(--error)', marginTop: 8 }}
              onClick={handleLogout}
            >
              <LogOut size={14} /> Log out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
