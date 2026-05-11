export interface Message {
  id: string
  conversationId: string
  senderId: string
  payload: Uint8Array
  msgType: 'TEXT' | 'IMAGE' | 'FILE' | 'SYSTEM'
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
  name?: string          // display name (may be UUID slice as fallback)
  peerUsername?: string  // guaranteed-correct remote username for initiateSession
}
