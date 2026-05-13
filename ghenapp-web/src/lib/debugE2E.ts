/**
 * GhenApp E2E Debug Instrumentation
 *
 * Attach to window so it can be called from the browser DevTools console:
 *
 *   await window.__ghenDebug.run()
 *   await window.__ghenDebug.run('4f7c55fb-...')  // specific conv
 */

import { openDB } from 'idb'
import { getIdentityKey } from '../ws/client'
import { loadPrivateKey } from '../crypto/keygen'
import { loadSession } from '../crypto/ratchet'
import * as api from './api'

const DB_NAME = 'ghenapp-msgcache'
const SESSION_DB = 'ghenapp-sessions'
const SESSION_STORE = 'ratchet'

// ─── helpers ──────────────────────────────────────────────────────────────────

function toHex(b: Uint8Array | null | undefined, maxBytes = 8): string {
  if (!b || b.length === 0) return '(empty)'
  const s = Array.from(b.slice(0, maxBytes)).map(x => x.toString(16).padStart(2, '0')).join('')
  return b.length > maxBytes ? s + `…(${b.length}B)` : s
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function openMsgCache() {
  return openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('msg_id')) db.createObjectStore('msg_id')
      if (!db.objectStoreNames.contains('msg_hash')) db.createObjectStore('msg_hash')
    }
  })
}

async function countIdCacheForConv(db: Awaited<ReturnType<typeof openMsgCache>>, convId: string): Promise<number> {
  let count = 0
  let cursor = await db.transaction('msg_id').store.openCursor()
  while (cursor) {
    if ((cursor.key as string).startsWith(convId + ':')) count++
    cursor = await cursor.continue()
  }
  return count
}

async function countHashCacheForConv(db: Awaited<ReturnType<typeof openMsgCache>>, convId: string): Promise<number> {
  let count = 0
  let cursor = await db.transaction('msg_hash').store.openCursor()
  while (cursor) {
    const val = cursor.value as string
    if (val.startsWith(convId + ':')) count++
    cursor = await cursor.continue()
  }
  return count
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface DebugReport {
  timestamp: string
  identityKey: {
    inMemory: boolean
    inIDB: boolean
    pubKeyHex: string
    privKeyLength: number | null
  }
  conversations: ConvDebugReport[]
}

export interface ConvDebugReport {
  convId: string
  ratchetSession: {
    exists: boolean
    role: string | null
    sendMsgNum: number | null
    recvMsgNum: number | null
    sendChainKeyPresent: boolean
    recvChainKeyPresent: boolean
    dhrPresent: boolean
    dhsPublicHex: string
    dhrHex: string
  }
  cache: {
    idCacheEntries: number
    hashCacheEntries: number
  }
  messages: MsgDebugReport[]
}

export interface MsgDebugReport {
  msgId: string
  senderId: string
  payloadTypeByte: string
  payloadLength: number
  senderPubHex: string
  isMineByStoreCheck: boolean
  isMineByPubKeyCheck: boolean
  isMineCheckAgreed: boolean
  idCacheHit: boolean
  hashCacheHit: boolean
  willShowEncrypted: boolean
  warning: string
}

// ─── main runner ──────────────────────────────────────────────────────────────

async function runDebug(targetConvId?: string): Promise<DebugReport> {
  console.group('%c[GhenDebug] Running E2E diagnostics...', 'color:#a78bfa;font-weight:bold')

  // ── 1. Identity key ──────────────────────────────────────────────────────────
  const memKey = getIdentityKey()
  const username: string = (window as any).__ghenUsername ||
    JSON.parse(localStorage.getItem('ghen_user') ?? '{}')?.username ||
    'unknown'

  let idbPrivKey: Uint8Array | null = null
  try {
    idbPrivKey = await loadPrivateKey(username)
  } catch (_e) {
    // loadPrivateKey failed — idbPrivKey stays null
  }

  const activeKey = memKey ?? idbPrivKey
  const ownPub = activeKey
    ? (activeKey.length === 64 ? activeKey.slice(32, 64) : activeKey)
    : null
  const ownPubHex = ownPub ? toHex(ownPub, 32) : '(MISSING — this is the problem!)'

  const identityInfo = {
    inMemory: !!memKey,
    inIDB: !!idbPrivKey,
    pubKeyHex: ownPubHex,
    privKeyLength: activeKey?.length ?? null,
  }

  console.log('%c[1] Identity Key', 'color:#34d399;font-weight:bold', identityInfo)
  if (!memKey) {
    console.warn('[!] Identity key NOT in memory — hard-reload or WS handshake not done yet.')
    console.warn('[!] Own-message guard will fail until WS handshake completes.')
  }
  if (!idbPrivKey) {
    console.error('[!!] Identity key NOT in IDB either. User may not be registered on this device.')
  }

  // ── 2. Conversations ─────────────────────────────────────────────────────────
  let convIds: string[] = []
  try {
    const store = (window as any).__ghenStore
    if (store) {
      const convs = store.getState().conversations as Array<{ id: string }>
      convIds = convs.map(c => c.id)
    } else {
      const data = await api.getConversations()
      convIds = data.conversations.map((c: any) => c.id)
    }
  } catch (e) {
    console.warn('[!] Could not load conversations:', e)
  }

  if (targetConvId) convIds = [targetConvId]

  const msgCacheDB = await openMsgCache()
  const convReports: ConvDebugReport[] = []

  for (const convId of convIds.slice(0, 10)) {
    console.group(`%c[Conv] ${convId.slice(0, 8)}...`, 'color:#60a5fa')

    // ── Ratchet session ────────────────────────────────────────────────────────
    const session = await loadSession(convId)
    const ratchetInfo: ConvDebugReport['ratchetSession'] = {
      exists: !!session,
      role: session?.role ?? null,
      sendMsgNum: session?.sendMsgNum ?? null,
      recvMsgNum: session?.recvMsgNum ?? null,
      sendChainKeyPresent: !!session?.sendChainKey,
      recvChainKeyPresent: !!session?.recvChainKey,
      dhrPresent: !!session?.dhr,
      dhsPublicHex: session ? toHex(session.dhs.publicKey) : '(no session)',
      dhrHex: session?.dhr ? toHex(session.dhr) : '(null)',
    }
    console.log('Ratchet session:', ratchetInfo)
    if (!session) console.warn('[!] NO ratchet session — all peer messages will fail to decrypt')
    if (session && !session.recvChainKey) console.warn('[!] recvChainKey is null — receiving chain not yet initialised')

    // ── Cache counts ───────────────────────────────────────────────────────────
    const idCount = await countIdCacheForConv(msgCacheDB, convId)
    const hashCount = await countHashCacheForConv(msgCacheDB, convId)
    console.log(`Cache: ${idCount} id-entries, ${hashCount} hash-entries`)

    // ── Messages ───────────────────────────────────────────────────────────────
    let serverMessages: any[] = []
    try {
      const data = await api.getMessages(convId)
      serverMessages = [...data.messages].sort((a, b) => b.timestamp_ms - a.timestamp_ms).slice(0, 20)
    } catch (e) {
      console.warn('[!] Could not load messages:', e)
    }

    const msgReports: MsgDebugReport[] = []
    const userId: string = (window as any).__ghenUserId ||
      JSON.parse(localStorage.getItem('ghen_user') ?? '{}')?.id || ''

    for (const m of serverMessages) {
      const rawPayload = new Uint8Array(m.payload)
      const typeByte = rawPayload.length > 0 ? `0x${rawPayload[0].toString(16).padStart(2, '0')}` : '(empty)'

      const isMineByStore = m.sender_id === userId || m.sender_id === username

      let isMineByPubKey = false
      let senderPubHex = '(not a 0x02 frame)'
      if (rawPayload.length >= 33 && rawPayload[0] === 0x02 && ownPub) {
        const senderPub = rawPayload.slice(1, 33)
        senderPubHex = toHex(senderPub, 32)
        isMineByPubKey = bytesEqual(senderPub, ownPub)
      }

      let idCacheHit = false
      let hashCacheHit = false
      const idKey = `${convId}:${m.id.toString()}`
      const idVal = await msgCacheDB.get('msg_id', idKey)
      if (idVal != null) idCacheHit = true

      if (!idCacheHit && rawPayload.length > 0) {
        const hashBuf = await crypto.subtle.digest('SHA-256', rawPayload.buffer.slice(rawPayload.byteOffset, rawPayload.byteOffset + rawPayload.byteLength) as ArrayBuffer)
        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
        const hashVal = await msgCacheDB.get('msg_hash', hashHex)
        if (hashVal != null) hashCacheHit = true
      }

      const willShowEncrypted = !idCacheHit && !hashCacheHit && (isMineByStore || !session)

      let warning = ''
      if (isMineByStore && !isMineByPubKey && rawPayload[0] === 0x02) {
        warning += '[DANGER] Store says mine but pubkey does NOT match — own msg will fall through to decryptInbound! '
      }
      if (!isMineByStore && isMineByPubKey) {
        warning += '[WARN] PubKey says mine but store thinks peer message. '
      }
      if (rawPayload[0] === 0x02 && isMineByStore && !idCacheHit && !hashCacheHit) {
        warning += '[WILL SHOW ENCRYPTED] Own message not in cache. '
      }
      if (!session && !isMineByStore) {
        warning += '[NO SESSION] Peer message but no ratchet session. '
      }
      if (rawPayload.length === 0) {
        warning += '[EMPTY PAYLOAD] '
      }

      msgReports.push({
        msgId: m.id.toString(),
        senderId: m.sender_id,
        payloadTypeByte: typeByte,
        payloadLength: rawPayload.length,
        senderPubHex,
        isMineByStoreCheck: isMineByStore,
        isMineByPubKeyCheck: isMineByPubKey,
        isMineCheckAgreed: isMineByStore === isMineByPubKey,
        idCacheHit,
        hashCacheHit,
        willShowEncrypted,
        warning,
      })
    }

    if (msgReports.length > 0) {
      console.table(msgReports.map(r => ({
        id: r.msgId.slice(-6),
        sender: r.senderId.slice(0, 8),
        type: r.payloadTypeByte,
        isMine_store: r.isMineByStoreCheck,
        isMine_pubkey: r.isMineByPubKeyCheck,
        agreed: r.isMineCheckAgreed,
        id_cache: r.idCacheHit,
        hash_cache: r.hashCacheHit,
        '🔒': r.willShowEncrypted,
        warn: r.warning.slice(0, 60) || '✓',
      })))
      const problems = msgReports.filter(r => r.warning)
      if (problems.length > 0) {
        console.warn(`[!] ${problems.length} message(s) with problems:`)
        problems.forEach(p => console.warn(`  msgId=${p.msgId} → ${p.warning}`))
      }
    }

    console.groupEnd()

    convReports.push({
      convId,
      ratchetSession: ratchetInfo,
      cache: { idCacheEntries: idCount, hashCacheEntries: hashCount },
      messages: msgReports,
    })
  }

  const report: DebugReport = {
    timestamp: new Date().toISOString(),
    identityKey: identityInfo,
    conversations: convReports,
  }

  console.log('%c[GhenDebug] Full report (copy this):', 'color:#f59e0b;font-weight:bold')
  console.log(JSON.stringify(report, null, 2))
  console.groupEnd()

  return report
}

// ─── Attach to window ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    __ghenDebug: { run: (convId?: string) => Promise<DebugReport> }
    __ghenUsername: string
    __ghenUserId: string
    __ghenStore: any
  }
}

if (typeof window !== 'undefined') {
  window.__ghenDebug = { run: runDebug }
}

export { runDebug }
