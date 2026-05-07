import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Plus, Search, LogOut, Settings, MessageSquare, Users, Wifi, WifiOff, Lock, Bell, BellOff, X
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useChatStore } from '../stores/chatStore'
import { GhenWSClient, encodeFrame, type DecodedFrame } from '../ws/client'
import * as api from '../lib/api'
import { initiateSession, encryptOutbound, decryptInbound } from '../crypto/session'
import { getPushState, requestPushPermission, unsubscribePush, type PushManagerState } from '../push/push'
import type { Message, Conversation } from '../types'

type WSStatus = 'connected' | 'disconnected' | 'reconnecting'

export default function ChatPage() {
  const user = useAuthStore((s) => s.user)
  const clearUser = useAuthStore((s) => s.clearUser)
  const {
    conversations, activeConversationId,
    messages, setActiveConversation, addMessage, markSent,
  } = useChatStore()

  const [text, setText] = useState('')
  const [wsStatus, setWsStatus] = useState<WSStatus>('disconnected')
  const [search, setSearch] = useState('')
  const [sending, setSending] = useState(false)
  const [encError, setEncError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [pushState, setPushState] = useState<PushManagerState>({ supported: false, permission: 'unsupported', subscribed: false })
  const wsRef = useRef<GhenWSClient | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ── WebSocket + E2E frame handler ────────────────────────────────────────────
  const handleFrame = useCallback(async (frame: DecodedFrame) => {
    // Attempt E2E decryption
    let decryptedText: string | undefined
    if (user) {
      const plain = await decryptInbound(frame.payload, frame.conversationId)
      decryptedText = plain ?? undefined
    }

    const msg: Message = {
      id: frame.id.toString(),
      conversationId: frame.conversationId,
      senderId: 'remote',
      payload: frame.payload,
      msgType: frame.msgType,
      timestampMs: frame.timestampMs,
      ttlSeconds: frame.ttlSeconds,
      decryptedText,
      status: 'delivered',
    }
    addMessage(frame.conversationId, msg)
  }, [addMessage, user])

  useEffect(() => {
    const token = sessionStorage.getItem('ghen_access_token')
    if (!token) return
    const client = new GhenWSClient(handleFrame, setWsStatus)
    client.connect(token, user?.username ?? '')
    wsRef.current = client
    return () => { client.disconnect(); wsRef.current = null }
  }, [handleFrame])

  // ── Push state sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    getPushState().then(setPushState)
  }, [])

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
      const payload = await encryptOutbound(text.trim(), activeConversationId)
      const msgId = BigInt(Date.now())
      const frame = encodeFrame({
        msgType: 'TEXT',
        id: msgId,
        conversationId: activeConversationId,
        payload,
      })

      // Add message optimistically as 'sending'
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
      setText('')

      // Await the actual WS send — mark 'sent' on success (server received it)
      // 'delivered' is only set when the server echoes the message back
      await wsRef.current.send(frame)
      markSent(activeConversationId, msgId.toString())
    } catch (err: any) {
      setEncError(err.message ?? 'Encryption failed — session not established?')
    } finally {
      setSending(false)
    }
  }

  // ── New DM — initiates X3DH session ─────────────────────────────────────────
  async function handleNewDM() {
    const raw = window.prompt('Enter username to chat with:')
    if (!raw?.trim() || !user) return
    const target = raw.trim().toLowerCase()
    try {
      const convId = crypto.randomUUID()
      await initiateSession(user.username, target, convId)
      const conv: Conversation = {
        id: convId,
        type: 'direct',
        participants: [user.id, target],
        unreadCount: 0,
        name: target,
      }
      useChatStore.getState().setConversations([
        ...useChatStore.getState().conversations, conv,
      ])
      setActiveConversation(convId)
    } catch (err: any) {
      alert(`Failed to open conversation: ${err.message}`)
    }
  }

  // ── Logout ───────────────────────────────────────────────────────────────────
  async function handleLogout() {
    const rt = localStorage.getItem('ghen_refresh_token')
    if (rt) await api.logout(rt).catch(() => {})
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
            <button onClick={handleNewDM} className="btn btn-ghost" style={{ padding: '6px 10px' }} title="New conversation">
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
              <button onClick={handleNewDM} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 8, fontSize: 13 }}>
                Start one →
              </button>
            </div>
          )}
          {filteredConvs.map((conv) => (
            <div
              key={conv.id}
              className={`conv-item ${activeConversationId === conv.id ? 'active' : ''}`}
              onClick={() => setActiveConversation(conv.id)}
            >
              <div className="conv-avatar">
                {conv.type === 'group' ? <Users size={16} /> : (conv.name?.[0] ?? '?').toUpperCase()}
              </div>
              <div className="conv-info">
                <div className="conv-name">{conv.name ?? conv.id.slice(0, 8)}</div>
                <div className="conv-preview">
                  {conv.lastMessage?.decryptedText
                    ? conv.lastMessage.decryptedText
                    : <span style={{ fontStyle: 'italic' }}>🔒 encrypted</span>
                  }
                </div>
              </div>
              <div className="conv-meta">
                {conv.lastMessage && (
                  <span className="conv-time">
                    {new Date(conv.lastMessage.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {conv.unreadCount > 0 && <span className="conv-badge">{conv.unreadCount}</span>}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Chat panel ── */}
      <main className="chat-panel">
        {!activeConversationId ? (
          <div className="empty-state">
            <div className="empty-state-icon"><MessageSquare size={48} /></div>
            <p style={{ fontWeight: 600, fontSize: 16 }}>No conversation selected</p>
            <p style={{ fontSize: 13 }}>Pick one from the sidebar or start a new chat.</p>
            <button className="btn btn-primary" onClick={handleNewDM} style={{ marginTop: 8 }}>
              <Plus size={15} /> New Conversation
            </button>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <div className="conv-avatar" style={{ width: 36, height: 36, fontSize: 13 }}>
                {(activeConv?.name?.[0] ?? '?').toUpperCase()}
              </div>
              <div className="chat-header-info">
                <div className="chat-header-name">{activeConv?.name ?? 'Unknown'}</div>
                <div className="chat-header-status" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Lock size={10} /> end-to-end encrypted
                </div>
              </div>
              <Settings
                size={18}
                style={{ color: 'var(--text-muted)', cursor: 'pointer' }}
                onClick={() => setShowSettings((v) => !v)}
              />
            </div>

            {/* ── Settings panel ── */}
            {showSettings && (
              <div style={{
                position: 'absolute', top: 60, right: 16, zIndex: 100,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 12, padding: 16, width: 260,
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Settings</span>
                  <X size={14} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setShowSettings(false)} />
                </div>
                {pushState.supported ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {pushState.subscribed ? <Bell size={13} /> : <BellOff size={13} style={{ opacity: 0.5 }} />}
                      Push notifications
                    </span>
                    <button
                      className={`btn ${pushState.subscribed ? 'btn-ghost' : 'btn-primary'}`}
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={togglePush}
                      disabled={pushState.permission === 'denied'}
                    >
                      {pushState.permission === 'denied'
                        ? 'Blocked'
                        : pushState.subscribed ? 'Turn off' : 'Enable'}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Push notifications not supported in this browser.</p>
                )}
              </div>
            )}

            <div className="chat-messages">
              {activeMessages.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, paddingTop: 32 }}>
                  <Lock size={20} style={{ marginBottom: 8, opacity: 0.5 }} /><br />
                  Messages are end-to-end encrypted.<br />
                  Say hi! 👋
                </div>
              )}
              {activeMessages.map((msg) => {
                const isMine = msg.senderId === user?.id || msg.senderId === user?.username
                return (
                  <div key={msg.id} className={`msg-row ${isMine ? 'mine' : ''}`}>
                    <div className={`msg-bubble ${isMine ? 'mine' : 'theirs'}`}>
                      {msg.decryptedText != null
                        ? msg.decryptedText
                        : <span className="msg-encrypted">🔒 encrypted message</span>
                      }
                      <span className="msg-time">
                        {new Date(msg.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {isMine && ` · ${msg.status}`}
                      </span>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            {encError && (
              <div style={{ padding: '8px 24px', background: 'rgba(239,68,68,0.1)', borderTop: '1px solid rgba(239,68,68,0.2)', color: 'var(--red)', fontSize: 12 }}>
                ⚠ {encError}
              </div>
            )}

            <div className="chat-input-bar">
              <textarea
                className="chat-textarea"
                placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
                value={text}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
                }}
              />
              <button
                className="chat-send-btn"
                onClick={sendMessage}
                disabled={!text.trim() || wsStatus !== 'connected' || sending}
                title="Send encrypted message (Enter)"
              >
                {sending
                  ? <span style={{ fontSize: 10, animation: 'pulse 1s infinite' }}>⏳</span>
                  : <Send size={18} />
                }
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
