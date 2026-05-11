export interface AuthUser {
  id: string
  username: string
  publicKey: Uint8Array | number[]
  displayName?: string | null
  tier?: 'free' | 'pro' | 'enterprise' | string
}

export interface Message {
  id: string
  conversationId: string
  senderId: string
  payload: Uint8Array
  msgType: 'TEXT' | 'IMAGE' | 'FILE' | 'SYSTEM' | 'VIDEO' | 'AUDIO' | 'STICKER' | 'REACTION' | 'CALL_SIGNAL'
  timestampMs: number
  ttlSeconds?: number
  decryptedText?: string
  status: 'sending' | 'sent' | 'delivered' | 'failed'
}

export interface Conversation {
  id: string
  type: 'direct' | 'group'
  participants: string[]
  unreadCount: number
  name?: string
  peerUsername?: string   // ← ADD THIS — guaranteed to be the real login username
  lastMessage?: Message
}
