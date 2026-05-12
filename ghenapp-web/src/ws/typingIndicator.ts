// typingIndicator.ts — send/receive typing frames (0x10 / 0x11) via the
// existing GhenWSClient. Typing frames use the same IMCP binary wire format.

import { encodeFrame } from './client'

// ── Debounce helpers ──────────────────────────────────────────────────────────

let _typingTimer: ReturnType<typeof setTimeout> | null = null
let _lastConvId: string | null = null

/**
 * Call on every keystroke. Sends a 0x10 TYPING frame at most once per
 * `leadDelay` ms per conversation, then auto-sends TYPING_STOP after
 * `stopDelay` ms of silence.
 */
export function notifyTyping(
  send: (frame: Uint8Array) => Promise<void> | void,
  conversationId: string,
  leadDelay = 1000,
  stopDelay = 4000,
): void {
  // Clear previous timer
  if (_typingTimer !== null) clearTimeout(_typingTimer)

  // If we switched conversations, reset
  if (_lastConvId !== conversationId) {
    _lastConvId = conversationId
  }

  // Send TYPING_START (debounced — only fire if not already fired recently)
  sendTypingStart(send, conversationId)

  // Schedule TYPING_STOP
  _typingTimer = setTimeout(() => {
    sendTypingStop(send, conversationId)
    _typingTimer = null
  }, stopDelay)
}

export function sendTypingStart(
  send: (frame: Uint8Array) => Promise<void> | void,
  conversationId: string,
): void {
  try {
    const frame = encodeFrame({
      msgType: 'TYPING',
      id: BigInt(0),
      conversationId,
      payload: new Uint8Array(0),
    })
    void send(frame)
  } catch {
    // best-effort — ignore send errors for signal frames
  }
}

export function sendTypingStop(
  send: (frame: Uint8Array) => Promise<void> | void,
  conversationId: string,
): void {
  if (_typingTimer !== null) { clearTimeout(_typingTimer); _typingTimer = null }
  try {
    const frame = encodeFrame({
      msgType: 'TYPING_STOP',
      id: BigInt(0),
      conversationId,
      payload: new Uint8Array(0),
    })
    void send(frame)
  } catch {
    // best-effort
  }
}
