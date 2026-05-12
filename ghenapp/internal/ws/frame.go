package ws

import (
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// IMCP wire format
// Frame layout:
//   [1 byte:  version]
//   [1 byte:  msg_type]
//   [8 bytes: snowflake ID]
//   [8 bytes: timestamp_ms  — truncated to second boundary (anti traffic-analysis)]
//   [4 bytes: ttl_seconds]
//   [16 bytes: conversation_id (UUID)]
//   [4 bytes:  payload_len]
//   [N bytes:  payload]
//   [2 bytes:  padding_len]
//   [M bytes:  padding (random, padded to nearest 256 bytes)]

const (
	IMCPVersion = byte(1)
	HeaderSize  = 1 + 1 + 8 + 8 + 4 + 16 + 4 // 42 bytes fixed header
	// PadBlockSize is the target padding block: all frames pad to a multiple of this.
	PadBlockSize = 256
)

// MsgType mirrors the IMCP message type enum.
type MsgType byte

const (
	MsgText       MsgType = 0x01
	MsgImage      MsgType = 0x02
	MsgVideo      MsgType = 0x03
	MsgAudio      MsgType = 0x04
	MsgFile       MsgType = 0x05
	MsgSticker    MsgType = 0x06
	MsgReaction   MsgType = 0x07
	MsgSystem     MsgType = 0x08
	MsgCallSignal MsgType = 0x09

	// Real-time signal frames — relayed only, never persisted to DB.
	MsgTyping     MsgType = 0x10 // sender is typing in conversation
	MsgTypingStop MsgType = 0x11 // sender stopped typing
	MsgReceipt    MsgType = 0x12 // read receipt — payload = 8-byte snowflake msg ID
)

// IsSignalFrame returns true for frames that are relay-only and never stored.
func (t MsgType) IsSignalFrame() bool {
	return t == MsgTyping || t == MsgTypingStop || t == MsgReceipt
}

// MaxPayloadByType returns the max allowed payload bytes for a message type.
func MaxPayloadByType(t MsgType) int {
	switch t {
	case MsgText:
		return 4 * 1024 // 4 KB
	case MsgSticker:
		return 256 * 1024 // 256 KB
	case MsgReaction:
		return 64 // 64 B
	case MsgSystem, MsgCallSignal:
		return 1024 // 1 KB
	case MsgTyping, MsgTypingStop:
		return 128 // tiny signal
	case MsgReceipt:
		return 8 // exactly one snowflake ID
	default: // IMAGE, VIDEO, AUDIO, FILE
		return 2 * 1024 * 1024 // 2 MB
	}
}

// Frame is the decoded IMCP wire frame.
type Frame struct {
	Version        byte
	Type           MsgType
	ID             int64    // Snowflake message ID
	TimestampMS    int64    // unix ms — truncated to second boundary on encode
	TTLSeconds     uint32   // 0 = no expiry
	ConversationID [16]byte // UUID bytes of conversation
	Payload        []byte   // E2E encrypted blob — server never inspects
	Padding        []byte   // random padding bytes
}

// Encode serializes a Frame into IMCP binary wire format.
// Timestamps are truncated to second boundary.
// Padding is normalized to PadBlockSize alignment.
func (f *Frame) Encode() ([]byte, error) {
	payLen := len(f.Payload)

	// Uniform envelope padding: pad total wire length to nearest PadBlockSize.
	// Wire size before padding field: HeaderSize + payLen + 2 (pad_len field).
	// We compute how many padding bytes are needed.
	wireBase := HeaderSize + payLen + 2
	remainder := wireBase % PadBlockSize
	padLen := 0
	if remainder != 0 {
		padLen = PadBlockSize - remainder
	}
	// Override caller-supplied padding with computed value.
	padding := make([]byte, padLen) // zero bytes — server side uses zeros; content is irrelevant
	total := wireBase + padLen

	buf := make([]byte, total)
	off := 0

	buf[off] = f.Version
	off++
	buf[off] = byte(f.Type)
	off++
	binary.BigEndian.PutUint64(buf[off:], uint64(f.ID))
	off += 8
	// Truncate timestamp to second boundary (anti traffic-analysis per spec)
	ts := f.TimestampMS / 1000 * 1000
	binary.BigEndian.PutUint64(buf[off:], uint64(ts))
	off += 8
	binary.BigEndian.PutUint32(buf[off:], f.TTLSeconds)
	off += 4
	copy(buf[off:], f.ConversationID[:])
	off += 16
	binary.BigEndian.PutUint32(buf[off:], uint32(payLen))
	off += 4
	copy(buf[off:], f.Payload)
	off += payLen
	binary.BigEndian.PutUint16(buf[off:], uint16(padLen))
	off += 2
	copy(buf[off:], padding)

	return buf, nil
}

// Decode parses raw IMCP binary frame bytes into a Frame struct.
func Decode(data []byte) (*Frame, error) {
	if len(data) < HeaderSize+2 {
		return nil, errors.New("frame too short")
	}

	f := &Frame{}
	off := 0

	f.Version = data[off]
	off++
	if f.Version != IMCPVersion {
		return nil, fmt.Errorf("unsupported IMCP version: %d", f.Version)
	}

	f.Type = MsgType(data[off])
	off++
	f.ID = int64(binary.BigEndian.Uint64(data[off:]))
	off += 8
	f.TimestampMS = int64(binary.BigEndian.Uint64(data[off:]))
	off += 8
	f.TTLSeconds = binary.BigEndian.Uint32(data[off:])
	off += 4
	copy(f.ConversationID[:], data[off:off+16])
	off += 16

	payLen := int(binary.BigEndian.Uint32(data[off:]))
	off += 4

	maxPay := MaxPayloadByType(f.Type)
	if payLen > maxPay {
		return nil, fmt.Errorf("payload too large: %d > %d", payLen, maxPay)
	}
	if off+payLen > len(data) {
		return nil, errors.New("payload length exceeds frame size")
	}
	f.Payload = make([]byte, payLen)
	copy(f.Payload, data[off:off+payLen])
	off += payLen

	if off+2 > len(data) {
		return nil, errors.New("frame truncated at padding length")
	}
	padLen := int(binary.BigEndian.Uint16(data[off:]))
	off += 2
	if off+padLen <= len(data) {
		f.Padding = make([]byte, padLen)
		copy(f.Padding, data[off:off+padLen])
	}

	return f, nil
}

// MsgTypeName returns a human-readable name for a message type.
func (t MsgType) String() string {
	names := map[MsgType]string{
		MsgText: "TEXT", MsgImage: "IMAGE", MsgVideo: "VIDEO",
		MsgAudio: "AUDIO", MsgFile: "FILE", MsgSticker: "STICKER",
		MsgReaction: "REACTION", MsgSystem: "SYSTEM", MsgCallSignal: "CALL_SIGNAL",
		MsgTyping: "TYPING", MsgTypingStop: "TYPING_STOP", MsgReceipt: "RECEIPT",
	}
	if n, ok := names[t]; ok {
		return n
	}
	return "UNKNOWN"
}

// ConversationIDToString encodes a 16-byte conversation ID as a UUID string.
func ConversationIDToString(id [16]byte) string {
	return uuid.UUID(id).String()
}

// ConversationIDFromBytes parses a 16-byte array back to uuid.UUID.
func ConversationIDFromBytes(id [16]byte) (uuid.UUID, error) {
	return uuid.UUID(id), nil
}
