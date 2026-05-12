// WebSocket client — IMCP binary framing with optional Noise_XX transport layer.
// Precedence: if server reports a noise pubkey, full Noise_XX handshake is done
// before any IMCP frames flow. Otherwise falls back to plain WebSocket.

import type { Message } from '../types'
import { NoiseChannel, type NoiseKeyPair } from './noise'
import { loadPrivateKey, ed25519ToX25519 } from '../crypto/keygen'

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080'
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'
const IMCP_VERSION = 1

const MSG_TYPE_MAP: Record<string, number> = {
  TEXT: 0x01, IMAGE: 0x02, VIDEO: 0x03, AUDIO: 0x04,
  FILE: 0x05, STICKER: 0x06, REACTION: 0x07,
  SYSTEM: 0x08, CALL_SIGNAL: 0x09,
}
const MSG_TYPE_NAMES: Record<number, Message['msgType']> = {
  0x01: 'TEXT', 0x02: 'IMAGE', 0x03: 'VIDEO', 0x04: 'AUDIO',
  0x05: 'FILE', 0x06: 'STICKER', 0x07: 'REACTION',
  0x08: 'SYSTEM', 0x09: 'CALL_SIGNAL',
}

// ─── Frame Encoder ────────────────────────────────────────────────────────────

export function encodeFrame(params: {
  msgType: Message['msgType']
  id: bigint
  conversationId: string
  payload: Uint8Array
  ttlSeconds?: number
}): Uint8Array {
  const convBytes = uuidToBytes(params.conversationId)
  const payLen = params.payload.length
  const total = 1 + 1 + 8 + 8 + 4 + 16 + 4 + payLen + 2

  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let off = 0

  view.setUint8(off++, IMCP_VERSION)
  view.setUint8(off++, MSG_TYPE_MAP[params.msgType] ?? 0x01)
  view.setBigInt64(off, params.id, false); off += 8
  view.setBigInt64(off, BigInt(Date.now()), false); off += 8
  view.setUint32(off, params.ttlSeconds ?? 0, false); off += 4
  bytes.set(convBytes, off); off += 16
  view.setUint32(off, payLen, false); off += 4
  bytes.set(params.payload, off); off += payLen
  view.setUint16(off, 0, false) // padding length = 0

  return bytes
}

// ─── Frame Decoder ────────────────────────────────────────────────────────────

export interface DecodedFrame {
  version: number
  msgType: Message['msgType']
  id: bigint
  timestampMs: number
  ttlSeconds: number
  conversationId: string
  payload: Uint8Array
  senderId?: string
}

function parseJSONEnvelope(data: ArrayBuffer): DecodedFrame | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    if (!text.startsWith('{')) return null
    const env = JSON.parse(text)
    if (!env.cid || !env.payload) return null
    return {
      version: 1,
      msgType: env.type as any,
      id: BigInt(env.id || 0),
      timestampMs: env.ts || 0,
      ttlSeconds: env.ttl || 0,
      conversationId: env.cid,
      senderId: env.sid,
      payload: Uint8Array.from(atob(env.payload), c => c.charCodeAt(0))
    }
  } catch {
    return null
  }
}


export function decodeFrame(data: ArrayBuffer): DecodedFrame | null {
  if (data.byteLength < 44) return null
  const view = new DataView(data)
  const bytes = new Uint8Array(data)
  let off = 0

  const version = view.getUint8(off++)
  if (version !== IMCP_VERSION) return null

  const typeCode = view.getUint8(off++)
  const msgType = MSG_TYPE_NAMES[typeCode] ?? 'SYSTEM'
  const id = view.getBigInt64(off, false); off += 8
  const timestampMs = Number(view.getBigInt64(off, false)); off += 8
  const ttlSeconds = view.getUint32(off, false); off += 4
  const convBytes = bytes.slice(off, off + 16); off += 16
  const payLen = view.getUint32(off, false); off += 4

  if (off + payLen > data.byteLength) return null
  const payload = bytes.slice(off, off + payLen)

  return { version, msgType, id, timestampMs, ttlSeconds, conversationId: bytesToUUID(convBytes), payload }
}

// ─── WebSocket Manager with Noise_XX support ──────────────────────────────────

export type FrameHandler = (frame: DecodedFrame) => void
export type StatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting') => void

export class GhenWSClient {
  private ws: WebSocket | null = null
  private noiseChannel: NoiseChannel | null = null
  private token: string = ''
  private username: string = ''
  private retryDelay = 1000
  private maxDelay = 30_000
  private stopped = false
  private onFrame: FrameHandler
  private onStatus: StatusHandler

  constructor(onFrame: FrameHandler, onStatus: StatusHandler) {
    this.onFrame = onFrame
    this.onStatus = onStatus
  }

  connect(token: string, username: string = '') {
    this.token = token
    this.username = username
    this.stopped = false
    this.retryDelay = 1000
    this._connect()
  }

  private async _connect() {
    if (this.stopped) return
    const url = `${WS_URL}/ws?token=${encodeURIComponent(this.token)}`
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = async () => {
      this.retryDelay = 1000
      try {
        await this._performNoise()
        this.onStatus('connected')
      } catch (err) {
        console.error('[ws] Noise handshake failed. Closing connection:', err)
        this.ws?.close()
      }
    }

    this.ws.onclose = () => {
      if (this.stopped) return
      this.noiseChannel = null
      this.onStatus('reconnecting')
      setTimeout(() => {
        this.retryDelay = Math.min(this.retryDelay * 2, this.maxDelay)
        this._connect()
      }, this.retryDelay)
    }

    this.ws.onerror = () => { this.ws?.close() }
  }

  private async _performNoise() {
    if (!this.ws) return

    // Fetch server's Noise static pubkey
    const accessToken = localStorage.getItem('ghen_access_token')
    const res = await fetch(`${API_URL}/api/v1/noise/pubkey`, {
      method: 'GET',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      cache: 'no-store', // Prevent browser from caching stale server pubkeys
    })
    if (!res.ok) throw new Error(`noise pubkey unavailable: ${res.status}`)
    const data = await res.json()
    const serverStaticPub = typeof data.public_key === 'string'
      ? Uint8Array.from(atob(data.public_key), c => c.charCodeAt(0))
      : new Uint8Array(data.public_key)

    // Derive client's X25519 static key from Ed25519 identity key
    let clientStatic: NoiseKeyPair
    if (this.username) {
      const privKey = await loadPrivateKey(this.username)
      if (privKey) {
        const x = await ed25519ToX25519(privKey)
        clientStatic = { publicKey: x.publicKey, privateKey: x.privateKey }
      } else {
        throw new Error('no local key for noise')
      }
    } else {
      throw new Error('username required for noise')
    }

    const nc = new NoiseChannel(this.ws)
    await nc.performHandshake(clientStatic, serverStaticPub, (data: ArrayBuffer) => {
      const frame = parseJSONEnvelope(data) || decodeFrame(data)
      if (frame) this.onFrame(frame)
    })
    this.noiseChannel = nc

  }

  async send(frame: Uint8Array) {
    if (this.noiseChannel?.handshakeDone) {
      await this.noiseChannel.send(frame)
    } else {
      console.warn('[ws] Cannot send frame: Noise handshake not complete')
    }
  }

  disconnect() {
    this.stopped = true
    this.noiseChannel = null
    this.ws?.close()
    this.ws = null
    this.onStatus('disconnected')
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

// ─── UUID helpers ─────────────────────────────────────────────────────────────

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
