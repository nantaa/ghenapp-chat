// noise_transport.go — wraps a gorilla WebSocket connection with Noise_XX
// transport encryption after the handshake is complete.
// The handshake is performed immediately after the WebSocket upgrade,
// before any IMCP frames are exchanged.

package ws

import (
	"encoding/binary"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

const (
	noiseHandshakeTimeout = 10 * time.Second
	// Wire protocol: each noise-encrypted message is prefixed with a 4-byte length
	noiseLenPrefix = 4
)

// NoiseConn wraps a gorilla WebSocket connection and provides transparent
// Noise-encrypted binary message send/receive after the handshake.
type NoiseConn struct {
	conn    *websocket.Conn
	encoder *NoiseCipher // for outbound frames (send)
	decoder *NoiseCipher // for inbound frames (recv)
}

// PerformServerHandshake executes the Noise_XX responder side over the given
// WebSocket connection. Returns a NoiseConn on success.
func PerformServerHandshake(conn *websocket.Conn, serverStatic NoiseKeyPair) (*NoiseConn, error) {
	conn.SetReadDeadline(time.Now().Add(noiseHandshakeTimeout))
	defer conn.SetReadDeadline(time.Time{}) // reset after handshake

	hs, err := NewNoiseHandshake(serverStatic)
	if err != nil {
		return nil, fmt.Errorf("noise handshake init: %w", err)
	}

	// ── Read msg1: [e] (32 bytes) ──
	_, msg1, err := conn.ReadMessage()
	if err != nil {
		return nil, fmt.Errorf("noise read msg1: %w", err)
	}
	if err := hs.ReadMsg1(msg1); err != nil {
		return nil, err
	}

	// ── Write msg2: [e, ee, s, es] ──
	msg2, err := hs.WriteMsg2()
	if err != nil {
		return nil, err
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, msg2); err != nil {
		return nil, fmt.Errorf("noise write msg2: %w", err)
	}

	// ── Read msg3: [s, se] ──
	_, msg3, err := conn.ReadMessage()
	if err != nil {
		return nil, fmt.Errorf("noise read msg3: %w", err)
	}
	if err := hs.ReadMsg3(msg3); err != nil {
		return nil, err
	}

	sendKey, recvKey := hs.TransportKeys()
	return &NoiseConn{
		conn:    conn,
		encoder: NewNoiseCipher(sendKey),
		decoder: NewNoiseCipher(recvKey),
	}, nil
}

// ReadFrame reads and decrypts one IMCP frame.
func (nc *NoiseConn) ReadFrame() ([]byte, error) {
	_, ct, err := nc.conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if len(ct) < noiseLenPrefix+tagLen {
		return nil, fmt.Errorf("noise: ciphertext too short (%d bytes)", len(ct))
	}
	// strip length prefix
	payload := ct[noiseLenPrefix:]
	return nc.decoder.Decrypt(payload)
}

// WriteFrame encrypts and sends one IMCP frame.
func (nc *NoiseConn) WriteFrame(plaintext []byte) error {
	ct, err := nc.encoder.Encrypt(plaintext)
	if err != nil {
		return err
	}
	// prepend 4-byte length (big-endian) for framing clarity
	wire := make([]byte, noiseLenPrefix+len(ct))
	binary.BigEndian.PutUint32(wire, uint32(len(ct)))
	copy(wire[noiseLenPrefix:], ct)
	return nc.conn.WriteMessage(websocket.BinaryMessage, wire)
}

// Close closes the underlying WebSocket connection.
func (nc *NoiseConn) Close() error {
	return nc.conn.Close()
}

// SetReadDeadline forwards to the underlying connection.
func (nc *NoiseConn) SetReadDeadline(t time.Time) error {
	return nc.conn.SetReadDeadline(t)
}

// SetPongHandler forwards to the underlying connection.
func (nc *NoiseConn) SetPongHandler(h func(string) error) {
	nc.conn.SetPongHandler(h)
}

// SendPing sends a WebSocket ping frame.
func (nc *NoiseConn) SendPing() error {
	return nc.conn.WriteMessage(websocket.PingMessage, nil)
}
