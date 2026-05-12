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
  msgType: 'TEXT' | 'IMAGE' | 'FILE' | 'SYSTEM' | 'VIDEO' | 'AUDIO' | 'STICKER' | 'REACTION' | 'CALL_SIGNAL' | 'TYPING' | 'TYPING_STOP' | 'RECEIPT'
  timestampMs: number
  ttlSeconds?: number
  decryptedText?: string
  status: 'sending' | 'sent' | 'delivered' | 'failed' | 'read'
}

export interface Conversation {
  id: string
  type: 'direct' | 'group'
  participants: string[]
  membersInfo?: { user_id: string; username: string }[]
  unreadCount: number
  name?: string
  peerUsername?: string   // ← ADD THIS — guaranteed to be the real login username
  lastMessage?: Message
}
