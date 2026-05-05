// GhenApp — Type definitions shared across the client
export type Tier = 'free' | 'premium'

export interface AuthUser {
  id: string
  username: string
  displayName: string | null
  publicKey: Uint8Array      // Ed25519 raw 32 bytes
  tier: Tier
}

export interface Message {
  id: string                 // Snowflake as string (BigInt safe)
  conversationId: string
  senderId: string
  payload: Uint8Array        // E2E encrypted blob — never plaintext
  msgType: MessageType
  timestampMs: number
  ttlSeconds?: number
  // Decrypted display (client-side only, never persisted)
  decryptedText?: string
  status: 'sending' | 'sent' | 'delivered' | 'failed'
}

export type MessageType =
  | 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO'
  | 'FILE' | 'STICKER' | 'REACTION'
  | 'SYSTEM' | 'CALL_SIGNAL'

export interface Conversation {
  id: string
  type: 'direct' | 'group'
  participants: string[]     // user IDs
  lastMessage?: Message
  unreadCount: number
  name?: string              // group name or peer username
  avatarUrl?: string
}

export interface PrekeyBundle {
  userId: string
  username: string
  publicKey: Uint8Array       // Ed25519 identity key
  keyVersion: number
  signedPrekey: {
    publicKey: Uint8Array
    signature: Uint8Array
  }
  onetimePrekey?: {
    publicKey: Uint8Array
  }
}

export interface Group {
  id: string
  conversationId: string
  name: string
  createdBy: string
  members: GroupMember[]
}

export interface GroupMember {
  userId: string
  role: 'admin' | 'member'
}

export interface UploadResult {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
}

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
}
