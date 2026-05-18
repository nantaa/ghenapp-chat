import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Plus, Search, LogOut, Settings, MessageSquare, Wifi, WifiOff, Lock, Bell, BellOff, X, Clock, AlertTriangle, RefreshCw
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import {
  useChatStore,
  getCachedDecryptedByPayload,
  cacheDecrypted,
  cacheDecryptedByPayload,
  warmCacheReady,
} from '../stores/chatStore'
import { GhenWSClient, encodeFrame, clearIdentityKey, type DecodedFrame } from '../ws/client'
import * as api from '../lib/api'
import {
  initiateSession,
  encryptOutbound,
  decryptInbound,
} from '../crypto/session'
import { storeTrustedKey } from '../crypto/keygen'
import {
  encryptGroupMessage,
  decryptGroupMessage,
  storeGroupSenderKey,
  loadGroupSenderKey,
  getMyGroupSenderKey,
} from '../crypto/senderKeys'
import { notifyTyping, sendTypingStop } from '../ws/typingIndicator'
import { loadSession, deleteSession } from '../crypto/ratchet'
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
  
  const [showNewGroupModal, setShowNewGroupModal] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupUsernames, setNewGroupUsernames] = useState('')
  const [newGroupError, setNewGroupError] = useState<string | null>(null)
  const [newGroupSubmitting, setNewGroupSubmitting] = useState(false)

  const [ttlSeconds, setTtlSeconds] = useState<number>(0)

  // Typing indicators: map of conversationId → username currently typing
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({})
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // TOFU key-change warning
  const [tofuWarning, setTofuWarning] = useState<{ username: string; onAccept: () => void } | null>(null)
  const [pushState, setPushState] = useState<PushManagerState>({
    supported: false,
    permission: 'unsupported',
    subscribed: false,
  })
  const wsRef = useRef<GhenWSClient | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const sentReceipts = useRef<Set<string>>(new Set())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // ── FIX #1: Persistent set of conversation IDs whose history has been loaded.
  // Using a ref (not state) so it never resets on re-render, only on full
  // component unmount (i.e. logout). This prevents the history-load useEffect
  // from re-firing on every activeConversationId change after a soft reload.
  const loadedConvsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    observerRef.current = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const msgIdStr = entry.target.getAttribute('data-msg-id')
          if (msgIdStr && activeConversationId && wsRef.current && !sentReceipts.current.has(msgIdStr)) {
            sentReceipts.current.add(msgIdStr)
            
            // Mark as read locally so we don't observe it again across re-renders
            useChatStore.getState().markRead(activeConversationId, msgIdStr)

            const idBytes = new ArrayBuffer(8)
            new DataView(idBytes).setBigInt64(0, BigInt(msgIdStr), false)
            const frame = encodeFrame({
              msgType: 'RECEIPT',
              id: BigInt(0),
              conversationId: activeConversationId,
              payload: new Uint8Array(idBytes),
            })
            wsRef.current.send(frame).catch(() => {})
          }
        }
      })
    }, { threshold: 0.1 })

    return () => observerRef.current?.disconnect()
  }, [activeConversationId])

  // ── WebSocket + E2E frame handler ─────────────────────────────────────────
  const handleFrame = useCallback(async (frame: DecodedFrame) => {
    if (!user) return

    // Handle signal frames — never add to message list
    if (frame.msgType === 'TYPING') {
      setTypingUsers((prev) => ({ ...prev, [frame.conversationId]: frame.senderId ?? 'someone' }))
      // auto-clear after 5 s
      const key = frame.conversationId
      if (typingTimers.current[key]) clearTimeout(typingTimers.current[key])
      typingTimers.current[key] = setTimeout(() =>
        setTypingUsers((prev) => { const n = { ...prev }; delete n[key]; return n }), 5000)
      return
    }
    if (frame.msgType === 'TYPING_STOP') {
      setTypingUsers((prev) => { const n = { ...prev }; delete n[frame.conversationId]; return n })
      return
    }
    if (frame.msgType === 'RECEIPT') {
      if (frame.payload && frame.payload.length === 8) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
        const msgIdStr = view.getBigInt64(0, false).toString()
        useChatStore.getState().markRead(frame.conversationId, msgIdStr)
      }
      return
    }

    // Inbound message from a peer ─────────────────────────────────────────
    // (Server never echoes frames back to sender, so every frame here is from a peer.)
    const storeMessages = useChatStore.getState().messages[frame.conversationId]
    const alreadyInStore = storeMessages?.some((m) => m.id === frame.id.toString())
    if (alreadyInStore) {
      markDelivered(frame.conversationId, frame.id.toString())
      return
    }

    const msgIsGroup = frame.payload.length > 0 && frame.payload[0] === 0x03

    let plain: string | null = null
    if (msgIsGroup) {
      const senderKey = await loadGroupSenderKey(frame.conversationId, frame.senderId || '')
      if (senderKey) {
        plain = await decryptGroupMessage(frame.payload, senderKey)
      } else {
        plain = `[Encrypted group message - missing key for ${frame.senderId}]`
      }
    } else {
      // Use decryptInbound (with queue/state-saving) for all DMs
      plain = await decryptInbound(frame.payload, frame.conversationId, user.username)
      
      // Check if it's a SYSTEM message containing a sender key
      if (plain && frame.msgType === 'SYSTEM') {
        try {
          const sysData = JSON.parse(plain)
          if (sysData.type === 'SENDER_KEY' && sysData.groupId && sysData.key) {
            const keyBytes = new Uint8Array(sysData.key.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)))
            await storeGroupSenderKey(sysData.groupId, frame.senderId || '', keyBytes)
            console.log('Stored sender key for', frame.senderId, 'in group', sysData.groupId)
          }
        } catch {}
        return // Do not display SYSTEM messages in UI
      }
    }
    const decryptedText = plain ?? undefined

    if (plain && frame.id && !msgIsGroup) {
      cacheDecrypted(frame.conversationId, frame.id.toString(), plain)
      cacheDecryptedByPayload(frame.conversationId, frame.payload, plain)
    }

    // Auto-add conversation to sidebar if we don't know about it yet
    const existingConv = useChatStore
      .getState()
      .conversations.find((c) => c.id === frame.conversationId)
    if (!existingConv) {
      const convData = await api.getConversations().catch(() => null)
      const stillMissing = !useChatStore
        .getState()
        .conversations.find((c) => c.id === frame.conversationId)
      if (stillMissing) {
        const match = convData?.conversations.find(
          (c: any) => c.id === frame.conversationId,
        )
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

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('ghen_access_token')
    if (!token) return
    const client = new GhenWSClient(handleFrame, setWsStatus)
    client.connect(token, user?.username ?? '')
    wsRef.current = client
    return () => {
      client.disconnect()
      wsRef.current = null
    }
  }, [handleFrame])

  // ── Fetch conversation list ───────────────────────────────────────────────
  useEffect(() => {
    if (!user) return
    api
      .getConversations()
      .then((data) => {
        const convs: Conversation[] = data.conversations.map((c: any) => {
          const otherMember = c.members.find((m: any) => m.user_id !== user.id)
          const peerUsername: string = otherMember?.username ?? ''
          const displayName = peerUsername || c.id.slice(0, 8)
          return {
            id: c.id,
            type: c.type as 'direct' | 'group',
            participants: c.members.map((m: any) => m.user_id),
            membersInfo: c.members,
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

  // ── Push state ────────────────────────────────────────────────────────────
  useEffect(() => {
    getPushState().then(setPushState)
  }, [])

  // ── Hydrate user.id if missing ────────────────────────────────────────────
  useEffect(() => {
    if (user && !user.id) {
      api
        .getUser(user.username)
        .then((profile) => {
          useAuthStore.getState().setUser({ ...user, id: profile.id })
        })
        .catch(console.error)
    }
  }, [user])

  // ── Load message history ──────────────────────────────────────────────────
  //
  // Priority per message:
  //   1. IDB id-cache hit           → instant, no crypto
  //   2. IDB hash-cache hit         → cross-session lookup by payload sha256
  //   3. Live decryptInbound        → peer messages ONLY (isMine=false)
  //
  // For sent messages (isMine):
  //   - Paths 1 and 2 are the ONLY options — we cannot re-decrypt our own
  //     ciphertext because the ratchet state is gone after a reload.
  //   - If both miss, we show "🔒 encrypted message".
  //   - We do NOT attempt path 3 for own messages — doing so would either
  //     fail silently or corrupt the ratchet chain.
  //
  // FIX: Guard with loadedConvsRef (a persistent ref-Set) instead of checking
  // `messages.length > 0`. The old guard failed on reload because the Zustand
  // store is reset to empty, making every conversation look unloaded and causing
  // the full decrypt loop to run again immediately after reload.
  useEffect(() => {
    if (!activeConversationId || !user) return

    // ── FIX #1 applied here ──────────────────────────────────────────────
    // Skip if we already loaded this conversation's history in this session.
    if (loadedConvsRef.current.has(activeConversationId)) return
    loadedConvsRef.current.add(activeConversationId)

    warmCacheReady
      .then(() => api.getMessages(activeConversationId))
      .then(async (data) => {
        const parsedMsgs: Message[] = []
        const sorted = [...data.messages].sort(
          (a, b) => a.timestamp_ms - b.timestamp_ms,
        )

        for (const m of sorted) {
          const rawPayload = new Uint8Array(m.payload)
          const isMine =
            m.sender_id === user.id || m.sender_id === user.username

          // Paths 1 + 2: cache lookup (works for both own and peer messages)
          let plain: string | undefined =
            (await getCachedDecryptedByPayload(
              m.conversation_id,
              m.id.toString(),
              rawPayload,
            )) ?? undefined

          // ── FIX #2: Path 3 ONLY for peer messages ────────────────────────
          // Never call decryptInbound for isMine — own ciphertext cannot be
          // decrypted without the ratchet state; attempting it would just
          // corrupt the ratchet chain or silently return null and waste cycles.
          if (plain == null && !isMine) {
            const msgIsGroup = rawPayload.length > 0 && rawPayload[0] === 0x03
            if (msgIsGroup) {
              const senderKey = await loadGroupSenderKey(m.conversation_id, m.sender_id)
              if (senderKey) {
                plain = (await decryptGroupMessage(rawPayload, senderKey)) ?? undefined
              } else {
                plain = `[Encrypted group message - missing key for ${m.sender_id}]`
              }
            } else {
              plain = (await decryptInbound(rawPayload, m.conversation_id, user.username)) ?? undefined
              
              if (plain && m.msg_type === 'SYSTEM') {
                try {
                  const sysData = JSON.parse(plain)
                  if (sysData.type === 'SENDER_KEY' && sysData.groupId && sysData.key) {
                    const keyBytes = new Uint8Array(sysData.key.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)))
                    await storeGroupSenderKey(sysData.groupId, m.sender_id, keyBytes)
                  }
                } catch {}
                continue // Do not show SYSTEM messages in UI
              }
            }

            // ── FIX #3: No explicit cacheDecrypted here ────────────────────
            // addMessage() below already calls cacheDecrypted internally via
            // chatStore.ts. Writing here too caused double IDB writes and the
            // 100+/min [CACHE] log spam visible in the console.
          }

          parsedMsgs.push({
            id: m.id.toString(),
            conversationId: m.conversation_id,
            senderId: m.sender_id,
            payload: rawPayload,
            msgType: m.msg_type as Message['msgType'],
            timestampMs: m.timestamp_ms,
            ttlSeconds: (m as any).ttl_seconds ?? 0,
            decryptedText: plain,
            status: (m as any).read ? 'delivered' : (m.delivered ? 'delivered' : 'sent'),
          })
        }

        parsedMsgs.sort((a, b) => a.timestampMs - b.timestampMs)

        const current =
          useChatStore.getState().messages[activeConversationId] ?? []
        const existingIds = new Set(current.map((x) => x.id))
        const fresh = parsedMsgs.filter((m) => !existingIds.has(m.id))
        if (fresh.length > 0) {
          useChatStore
            .getState()
            .setMessages(activeConversationId, [...fresh, ...current])
        }
      })
      .catch((e) => console.warn('[ChatPage] getMessages failed:', e))
  }, [activeConversationId, user?.id, user?.username])

  // ── Push toggle ───────────────────────────────────────────────────────────
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

  // ── Scroll to bottom ──────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeConversationId])

  // ── Send E2E message ──────────────────────────────────────────────────────
  async function sendMessage() {
    if (!text.trim() || !activeConversationId || !wsRef.current || !user) return

    setSending(true)
    setEncError(null)

    try {
      const activeConv = useChatStore
        .getState()
        .conversations.find((c) => c.id === activeConversationId)
      if (!activeConv) throw new Error('No active conversation selected')

      let payload: Uint8Array
      if (activeConv.type === 'group') {
        const mySenderKey = await getMyGroupSenderKey(activeConversationId, user.username)
        // Distribute sender key to members
        for (const member of activeConv.membersInfo ?? []) {
          if (member.username === user.username) continue
          const sentKey = `group-key-sent:${activeConversationId}:${member.username}`
          if (!localStorage.getItem(sentKey)) {
            try {
              const dmConv = await api.createDM(member.user_id)
              const dmConvId = dmConv.conversation_id
              const existingSession = await loadSession(dmConvId)
              if (!existingSession) {
                await initiateSessionWithTOFU(user.username, member.username, dmConvId)
              }
              const keyHex = Array.from(mySenderKey).map(b => b.toString(16).padStart(2, '0')).join('')
              const sysMsg = JSON.stringify({ type: 'SENDER_KEY', groupId: activeConversationId, key: keyHex })
              const sysPayload = await encryptOutbound(sysMsg, dmConvId, user.username)
              const EPOCH = 1700000000000n
              const sysId = (BigInt(Date.now()) - EPOCH) << 22n | BigInt(Math.floor(Math.random() * (1 << 22)))
              const sysFrame = encodeFrame({ msgType: 'SYSTEM', id: sysId, conversationId: dmConvId, payload: sysPayload })
              await wsRef.current.send(sysFrame)
              localStorage.setItem(sentKey, '1')
            } catch (e) {
              console.warn('Failed to send sender key to', member.username, e)
            }
          }
        }
        payload = await encryptGroupMessage(text.trim(), mySenderKey)
      } else {
        const targetUsername = activeConv.peerUsername?.trim().toLowerCase()
        if (!targetUsername) {
          throw new Error('Cannot determine peer username — try closing and reopening the conversation.')
        }

        const existing = await loadSession(activeConversationId)
        if (!existing) {
          await initiateSessionWithTOFU(user.username, targetUsername, activeConversationId)
        }

        payload = await encryptOutbound(text.trim(), activeConversationId, user.username)
      }

      const EPOCH = 1700000000000n
      const msgId =
        (BigInt(Date.now()) - EPOCH) << 22n |
        BigInt(Math.floor(Math.random() * (1 << 22)))

      const frame = encodeFrame({
        msgType: 'TEXT',
        id: msgId,
        conversationId: activeConversationId,
        payload,
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : undefined,
      })

      const plaintext = text.trim()

      // Cache plaintext BEFORE sending — critical for reload recovery.
      // If the page reloads before the server ACK arrives (and rekeyCache runs),
      // the hash cache entry ensures getCachedDecryptedByPayload can still find
      // the plaintext via path 2 on next load.
      cacheDecrypted(activeConversationId, msgId.toString(), plaintext)
      await cacheDecryptedByPayload(activeConversationId, payload, plaintext)

      const msg: Message = {
        id: msgId.toString(),
        conversationId: activeConversationId,
        senderId: user.id,
        payload,
        msgType: 'TEXT',
        timestampMs: Date.now(),
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : undefined,
        decryptedText: plaintext,
        status: 'sending',
      }

      addMessage(activeConversationId, msg)
      setText('')
      await wsRef.current.send(frame)
      markSent(activeConversationId, msgId.toString())
    } catch (err: any) {
      console.error('sendMessage failed:', err)
      setEncError(
        err?.message ?? 'Encryption failed — session not established?',
      )
    } finally {
      setSending(false)
    }
  }

  // ── Initiate session with TOFU check ────────────────────────────────────────
  async function initiateSessionWithTOFU(
    myUsername: string,
    targetUsername: string,
    conversationId: string,
    force = false,
  ): Promise<void> {
    try {
      await initiateSession(myUsername, targetUsername, conversationId, force)
    } catch (e: any) {
      if (e.name === 'KeyChangedError') {
        // Warn user — block until they explicitly accept
        await new Promise<void>((resolve) => {
          setTofuWarning({ username: targetUsername, onAccept: async () => {
            try {
              const bundle = await api.getPrekeys(targetUsername)
              if (bundle?.public_key?.length) {
                const pubHex = Array.from(bundle.public_key as number[])
                  .map((b: number) => b.toString(16).padStart(2, '0'))
                  .join('')
                await storeTrustedKey(targetUsername, pubHex)
              }
            } catch { /* best effort */ }
            setTofuWarning(null)
            resolve()
          }})
        })
        // Retry session initiation now that the key is trusted
        await initiateSession(myUsername, targetUsername, conversationId, force)
      } else {
        throw e
      }
    }
  }

  // ── Reset session ─────────────────────────────────────────────────────────
  async function resetSession() {
    if (!activeConversationId || !user) return
    const { deleteSession } = await import('../crypto/ratchet')
    await deleteSession(activeConversationId)
    const activeConv = useChatStore
      .getState()
      .conversations.find((c) => c.id === activeConversationId)
    const target = activeConv?.peerUsername
    if (target) {
      await initiateSession(
        user.username,
        target,
        activeConversationId,
        true,
      ).catch((e) => console.error('Reset failed:', e))
    }
    useChatStore.getState().setMessages(activeConversationId, [])
    // Allow history to reload for this conversation after reset
    loadedConvsRef.current.delete(activeConversationId)
    setShowSettings(false)
  }

  // ── New DM ────────────────────────────────────────────────────────────────
  async function handleNewDM() {
    const target = newDMUsername.trim().toLowerCase()
    if (!target || !user) return
    setNewDMSubmitting(true)
    setNewDMError(null)

    try {
      const bundle = (await api.getPrekeys(target)) as any
      if (!bundle || bundle.error)
        throw new Error(bundle?.error || 'User not found')
      if (!bundle.user_id) throw new Error('Invalid user data from server')

      const result = (await api.createDM(bundle.user_id)) as any
      if (!result?.conversation_id)
        throw new Error('Failed to create conversation')

      const conversationId = result.conversation_id
      await initiateSessionWithTOFU(user.username, target, conversationId)

      const newConv: Conversation = {
        id: conversationId,
        type: 'direct',
        participants: [user.id, bundle.user_id],
        membersInfo: [{ user_id: user.id, username: user.username }, { user_id: bundle.user_id, username: target }],
        unreadCount: 0,
        name: bundle.username || target,
        peerUsername: target,
      }

      useChatStore.getState().setConversations([
        newConv,
        ...useChatStore
          .getState()
          .conversations.filter((c) => c.id !== conversationId),
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

  // ── New Group ─────────────────────────────────────────────────────────────
  async function handleNewGroup() {
    if (!newGroupName.trim() || !newGroupUsernames.trim() || !user) return
    setNewGroupSubmitting(true)
    setNewGroupError(null)

    try {
      // 1. Create group
      const groupData = await api.createGroup(newGroupName.trim())
      const groupId = groupData.id
      const conversationId = groupData.conversation_id

      // 2. Add members
      const usernames = newGroupUsernames.split(',').map(u => u.trim().toLowerCase()).filter(Boolean)
      const membersInfo = [{ user_id: user.id, username: user.username }]
      
      for (const un of usernames) {
        if (un === user.username) continue
        try {
          const bundle = await api.getPrekeys(un) as any
          if (bundle?.user_id) {
            await api.addGroupMember(groupId, bundle.user_id)
            membersInfo.push({ user_id: bundle.user_id, username: un })
          }
        } catch (e) {
          console.warn(`Failed to add user ${un}:`, e)
        }
      }

      const newConv: Conversation = {
        id: conversationId,
        type: 'group',
        participants: membersInfo.map(m => m.user_id),
        membersInfo,
        unreadCount: 0,
        name: newGroupName.trim(),
      }

      useChatStore.getState().setConversations([
        newConv,
        ...useChatStore.getState().conversations.filter((c) => c.id !== conversationId),
      ])
      setActiveConversation(conversationId)
      setShowNewGroupModal(false)
      setNewGroupName('')
      setNewGroupUsernames('')
    } catch (err: any) {
      setNewGroupError(err?.message ?? 'Failed to create group')
    } finally {
      setNewGroupSubmitting(false)
    }
  }

  const filteredConvs = conversations.filter((c) =>
    c.name?.toLowerCase().includes(search.toLowerCase()),
  )

  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const activeMessages = activeConversationId
    ? (messages[activeConversationId] ?? [])
    : []

  function formatTime(ms: number) {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="chat-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="app-name">GhenApp</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className="icon-btn"
              title="New conversation"
              onClick={() => setShowNewDMModal(true)}
            >
              <Plus size={18} />
            </button>
            <button
              className="icon-btn"
              title="New group"
              onClick={() => setShowNewGroupModal(true)}
            >
              <MessageSquare size={18} />
            </button>
            <button
              className="icon-btn"
              title="Sign out"
              onClick={() => {
                clearIdentityKey()
                clearUser()
                localStorage.removeItem('ghen_access_token')
              }}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="user-row">
          <span className="username">@{user?.username}</span>
          <span className={`ws-badge ${wsStatus}`}>
            {wsStatus === 'connected' ? (
              <>
                <Wifi size={12} /> connected
              </>
            ) : wsStatus === 'reconnecting' ? (
              <>
                <WifiOff size={12} /> reconnecting
              </>
            ) : (
              <>
                <WifiOff size={12} /> disconnected
              </>
            )}
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
                    await initiateSession(
                      user.username,
                      otherUsername,
                      conv.id,
                    ).catch(() => { })
                  }
                }
              }}
            >
              <div className="conv-avatar">
                {(conv.name ?? conv.id)[0].toUpperCase()}
              </div>
              <div className="conv-meta">
                <span className="conv-name">{conv.name ?? conv.id.slice(0, 8)}</span>
                <span className="conv-sub">
                  <Lock size={10} /> encrypted
                </span>
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
                <div className="conv-avatar sm">
                  {(activeConv.name ?? activeConv.id)[0].toUpperCase()}
                </div>
                <div>
                  <div className="chat-peer-name">{activeConv.name}</div>
                  <div className="chat-e2e-badge">
                    <Lock size={11} /> end-to-end encrypted
                  </div>
                </div>
              </div>
              <div className="header-actions" style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="icon-btn"
                  title="Repair Chat / Reset Encryption"
                  onClick={async () => {
                    if (activeConversationId && confirm('Repair Chat? This will reset encryption and re-sync messages.')) {
                      await deleteSession(activeConversationId)
                      useChatStore.getState().setMessages(activeConversationId, [])
                      loadedConvsRef.current.delete(activeConversationId)
                      window.location.reload()
                    }
                  }}
                  style={{ color: '#ef4444' }}
                >
                  <RefreshCw size={18} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setShowSettings((s) => !s)}
                >
                  <Settings size={18} />
                </button>
              </div>
            </header>

            {showSettings && (
              <div className="settings-panel">
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%' }}
                  onClick={resetSession}
                >
                  🔄 Reset secure session
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={togglePush}
                >
                  {pushState.subscribed ? (
                    <>
                      <BellOff size={14} /> Disable notifications
                    </>
                  ) : (
                    <>
                      <Bell size={14} /> Enable notifications
                    </>
                  )}
                </button>
              </div>
            )}

            <div className="messages-wrap">
              {activeMessages.map((msg) => {
                const isMine =
                  msg.senderId === user?.id ||
                  msg.senderId === user?.username
                return (
                  <div
                    key={msg.id}
                    className={`msg-row ${isMine ? 'mine' : 'theirs'} ${msg.ttlSeconds ? 'msg-expiring' : ''}`}
                    data-msg-id={!isMine && msg.status !== 'read' ? msg.id : undefined}
                    ref={!isMine && msg.status !== 'read' ? (el) => { if (el) observerRef.current?.observe(el) } : undefined}
                  >
                    <div className={`msg-bubble ${isMine ? 'mine' : 'theirs'}`}>
                      {msg.decryptedText != null ? (
                        msg.decryptedText
                      ) : (
                        <span className="msg-encrypted">
                          🔒 encrypted message
                        </span>
                      )}
                      <div className="msg-meta">
                        {msg.ttlSeconds ? (
                          <span className="msg-ttl" title="Disappearing message">
                            <Clock size={10} style={{ marginRight: 2 }} />
                            {msg.ttlSeconds < 3600 ? `${msg.ttlSeconds / 60}m` : msg.ttlSeconds < 86400 ? `${msg.ttlSeconds / 3600}h` : `${msg.ttlSeconds / 86400}d`}
                          </span>
                        ) : null}
                        <span className="msg-time">
                          {formatTime(msg.timestampMs)}
                        </span>
                        {isMine && (
                          <span className="msg-status">
                            {msg.status === 'sending'
                              ? '·'
                              : msg.status === 'sent'
                                ? '✓'
                                : msg.status === 'delivered'
                                  ? '✓✓'
                                  : <span style={{ color: '#3b82f6', fontWeight: 'bold' }}>✓✓</span>}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
              {activeConversationId && typingUsers[activeConversationId] && (
                <div className="typing-indicator">
                  <span>{typingUsers[activeConversationId]} is typing</span>
                  <span className="typing-dots"><span/><span/><span/></span>
                </div>
              )}
            </div>

            {encError && (
              <div className="enc-error">
                <span>{encError}</span>
                <button className="icon-btn" onClick={() => setEncError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="input-bar">
              <select
                className="ttl-select"
                title="Disappearing messages"
                value={ttlSeconds}
                onChange={(e) => setTtlSeconds(Number(e.target.value))}
                style={{
                  marginRight: '8px',
                  padding: '6px',
                  borderRadius: '6px',
                  backgroundColor: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer'
                }}
              >
                <option value={0}>Off</option>
                <option value={60}>1m</option>
                <option value={3600}>1h</option>
                <option value={86400}>24h</option>
                <option value={604800}>7d</option>
              </select>
              <textarea
                className="msg-input"
                placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  if (wsRef.current && activeConversationId)
                    notifyTyping((f) => wsRef.current!.send(f), activeConversationId)
                }}
                onBlur={() => {
                  if (wsRef.current && activeConversationId)
                    sendTypingStop((f) => wsRef.current!.send(f), activeConversationId)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
                rows={1}
              />
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={sending || !text.trim()}
              >
                <Send size={18} />
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <MessageSquare size={48} className="empty-icon" />
            <p>No conversation selected</p>
            <p className="empty-sub">
              Pick one from the sidebar or start a new chat.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => setShowNewDMModal(true)}
            >
              <Plus size={16} /> New Conversation
            </button>
          </div>
        )}
      </main>

      {/* ── New DM modal ── */}
      {showNewDMModal && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewDMModal(false)
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <h2>New Conversation</h2>
              <button
                className="icon-btn"
                onClick={() => setShowNewDMModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <label className="form-label">Username</label>
              <input
                className="form-input"
                placeholder="Enter username..."
                value={newDMUsername}
                onChange={(e) => setNewDMUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewDM()
                }}
                autoFocus
              />
              {newDMError && <p className="form-error">{newDMError}</p>}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setShowNewDMModal(false)}
              >
                Cancel
              </button>
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

      {/* ── New Group modal ── */}
      {showNewGroupModal && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowNewGroupModal(false)
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <h2>New Group</h2>
              <button
                className="icon-btn"
                onClick={() => setShowNewGroupModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <label className="form-label">Group Name</label>
              <input
                className="form-input"
                placeholder="e.g. Project Apollo"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                autoFocus
                style={{ marginBottom: 12 }}
              />
              <label className="form-label">Members (comma separated usernames)</label>
              <input
                className="form-input"
                placeholder="e.g. alice, bob, charlie"
                value={newGroupUsernames}
                onChange={(e) => setNewGroupUsernames(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewGroup()
                }}
              />
              {newGroupError && <p className="form-error">{newGroupError}</p>}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setShowNewGroupModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleNewGroup}
                disabled={newGroupSubmitting || !newGroupName.trim() || !newGroupUsernames.trim()}
              >
                {newGroupSubmitting ? 'Creating...' : 'Create Group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── TOFU key-change warning ── */}
      {tofuWarning && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <AlertTriangle size={18} style={{ color: '#f59e0b' }} />
              <h2 style={{ color: '#f59e0b', marginLeft: 8 }}>Security Warning</h2>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, lineHeight: 1.6 }}>
                ⚠️ <strong>{tofuWarning.username}</strong>'s encryption key has changed since your last conversation.
                This could indicate a new device or — rarely — a man-in-the-middle attack.
                Verify their identity in person before continuing.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setTofuWarning(null)}>Block</button>
              <button className="btn btn-primary" style={{ background: '#f59e0b' }} onClick={tofuWarning.onAccept}>
                Accept & Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}