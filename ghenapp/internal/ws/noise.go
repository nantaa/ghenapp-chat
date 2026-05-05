// Noise_XX protocol implementation for GhenApp WebSocket transport security.
//
// Pattern: Noise_XX_25519_ChaChaPoly_SHA256
//   → e                           (initiator sends ephemeral pubkey)
//   ← e, ee, s, es                (responder sends ephemeral pubkey, mixes DH keys, sends encrypted static pubkey)
//   → s, se                       (initiator sends encrypted static pubkey, mixes DH key)
//
// This gives:
//   - Mutual authentication (both static keys authenticated)
//   - Forward secrecy (ephemeral-ephemeral DH)
//   - Identity hiding (static keys sent only after encryption established)
//   - Channel binding: after handshake, a transport key pair is derived
//
// References:
//   https://noiseprotocol.org/noise.html
//   https://noiseprotocol.org/noise.html#the-xx-pattern

package ws

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
)

// ─── Constants ────────────────────────────────────────────────────────────────

const (
	// Noise protocol name for handshake hash initialisation
	noiseProtocolName = "Noise_XX_25519_ChaChaPoly_SHA256"

	dhLen        = 32 // X25519 key length
	tagLen       = 16 // ChaCha20-Poly1305 AEAD tag
	nonceLen     = 12 // ChaCha20-Poly1305 nonce (96-bit)

	// Handshake message sizes (bytes)
	// Msg1: [e(32)]
	// Msg2: [e(32)] [enc_s(32+16)] [enc_payload if any]
	// Msg3: [enc_s(32+16)] [enc_payload if any]
	noiseMsg1Len = dhLen                        // 32
	noiseMsg2Len = dhLen + dhLen + tagLen        // 80
	noiseMsg3Len = dhLen + tagLen                // 48
)

// ─── Key types ────────────────────────────────────────────────────────────────

type noiseKey [32]byte

// NoiseKey is a 32-byte X25519 key (exported alias for testing and external use).
type NoiseKey = noiseKey

// NoiseKeyPair is an X25519 static or ephemeral keypair for Noise.
type NoiseKeyPair struct {
	Public  noiseKey
	Private noiseKey
}

// GenerateNoiseKeyPair generates a fresh X25519 keypair for use as the server's
// static identity key. Call this once at server startup and persist the private key.
func GenerateNoiseKeyPair() (NoiseKeyPair, error) {
	var kp NoiseKeyPair
	if _, err := io.ReadFull(rand.Reader, kp.Private[:]); err != nil {
		return kp, fmt.Errorf("noise: keygen: %w", err)
	}
	pub, err := curve25519.X25519(kp.Private[:], curve25519.Basepoint)
	if err != nil {
		return kp, fmt.Errorf("noise: pubkey: %w", err)
	}
	copy(kp.Public[:], pub)
	return kp, nil
}

func dh(priv, pub noiseKey) (noiseKey, error) {
	out, err := curve25519.X25519(priv[:], pub[:])
	if err != nil {
		return noiseKey{}, err
	}
	var r noiseKey
	copy(r[:], out)
	return r, nil
}

// ─── Symmetric State ──────────────────────────────────────────────────────────

type symmetricState struct {
	ck noiseKey  // chaining key
	h  noiseKey  // handshake hash
	k  noiseKey  // current cipher key (zero = no key yet)
	n  uint64    // nonce counter
}

func newSymmetricState() *symmetricState {
	s := &symmetricState{}
	// h = SHA256(protocol_name) — padded or hashed to 32 bytes
	name := []byte(noiseProtocolName)
	if len(name) <= 32 {
		copy(s.h[:], name)
	} else {
		s.h = sha256.Sum256(name)
	}
	// ck = h
	s.ck = s.h
	return s
}

func (s *symmetricState) mixHash(data []byte) {
	h := sha256.New()
	h.Write(s.h[:])
	h.Write(data)
	copy(s.h[:], h.Sum(nil))
}

func (s *symmetricState) mixKey(dhOutput noiseKey) {
	// HKDF(ck, dhOutput) → (ck, k)
	ck, k := hkdf2(s.ck, dhOutput)
	s.ck = ck
	s.k = k
	s.n = 0
}

func (s *symmetricState) encryptAndHash(plaintext []byte) ([]byte, error) {
	if s.k == (noiseKey{}) {
		// No key yet — pass through and mix hash
		s.mixHash(plaintext)
		return plaintext, nil
	}
	nonce := buildNonce(s.n)
	s.n++
	aead, err := chacha20poly1305.New(s.k[:])
	if err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce, plaintext, s.h[:])
	s.mixHash(ct)
	return ct, nil
}

func (s *symmetricState) decryptAndHash(ciphertext []byte) ([]byte, error) {
	if s.k == (noiseKey{}) {
		s.mixHash(ciphertext)
		return ciphertext, nil
	}
	nonce := buildNonce(s.n)
	s.n++
	aead, err := chacha20poly1305.New(s.k[:])
	if err != nil {
		return nil, err
	}
	pt, err := aead.Open(nil, nonce, ciphertext, s.h[:])
	if err != nil {
		return nil, fmt.Errorf("noise: decrypt: %w", err)
	}
	s.mixHash(ciphertext)
	return pt, nil
}

// split derives the final transport key pair from the handshake state.
func (s *symmetricState) split() (send, recv noiseKey) {
	send, recv = hkdf2(s.ck, noiseKey{})
	return
}

// ─── Handshake State — Initiator (Client) ────────────────────────────────────

// NoiseHandshakeInitiator holds the state for a Noise_XX client-side handshake.
type NoiseHandshakeInitiator struct {
	ss           *symmetricState
	localStatic  NoiseKeyPair
	localEphem   NoiseKeyPair
	remoteStatic noiseKey // server's known static pubkey
	remoteEphem  noiseKey // server's ephemeral (from msg2)
	done         bool
	sendKey      noiseKey
	recvKey      noiseKey
}

// NewNoiseHandshakeInitiator creates a client-side Noise_XX handshake.
// serverStaticPub is the server's known static public key (obtained out-of-band,
// e.g., via the API endpoint /api/v1/noise/pubkey).
func NewNoiseHandshakeInitiator(clientStatic NoiseKeyPair, serverStaticPub noiseKey) (*NoiseHandshakeInitiator, error) {
	ephem, err := GenerateNoiseKeyPair()
	if err != nil {
		return nil, err
	}
	h := &NoiseHandshakeInitiator{
		ss:           newSymmetricState(),
		localStatic:  clientStatic,
		localEphem:   ephem,
		remoteStatic: serverStaticPub,
	}
	h.ss.mixHash([]byte{}) // empty prologue
	return h, nil
}

// WriteMsg1 builds the initiator's first message: [e]
func (h *NoiseHandshakeInitiator) WriteMsg1() ([]byte, error) {
	h.ss.mixHash(h.localEphem.Public[:])
	return append([]byte{}, h.localEphem.Public[:]...), nil
}

// ReadMsg2 processes the responder's second message: [e, ee, s, es]
func (h *NoiseHandshakeInitiator) ReadMsg2(msg []byte) error {
	if len(msg) < dhLen+dhLen+tagLen {
		return errors.New("noise: msg2 too short")
	}

	// e: read server ephemeral
	copy(h.remoteEphem[:], msg[:dhLen])
	h.ss.mixHash(h.remoteEphem[:])

	// ee: DH(localEphem, remoteEphem)
	ee, err := dh(h.localEphem.Private, h.remoteEphem)
	if err != nil {
		return err
	}
	h.ss.mixKey(ee)

	// s: decrypt server's static public key
	encS := msg[dhLen : dhLen+dhLen+tagLen]
	pt, err := h.ss.decryptAndHash(encS)
	if err != nil {
		return fmt.Errorf("noise: msg2 decrypt s: %w", err)
	}
	copy(h.remoteStatic[:], pt)

	// es: from initiator's view = DH(initiator_ephemeral, responder_static)
	// (mirror of server's es = DH(server_static, client_ephemeral))
	es, err := dh(h.localEphem.Private, h.remoteStatic)
	if err != nil {
		return err
	}
	h.ss.mixKey(es)
	return nil
}

// WriteMsg3 builds the initiator's third message: [s, se]
func (h *NoiseHandshakeInitiator) WriteMsg3() ([]byte, error) {
	// s: encrypt client's static public key
	encS, err := h.ss.encryptAndHash(h.localStatic.Public[:])
	if err != nil {
		return nil, err
	}

	// se: DH(localStatic, remoteEphem)
	se, err := dh(h.localStatic.Private, h.remoteEphem)
	if err != nil {
		return nil, err
	}
	h.ss.mixKey(se)

	// Split
	h.sendKey, h.recvKey = h.ss.split()
	h.done = true
	return encS, nil
}

// TransportKeys returns the derived (send, recv) keys for the initiator.
func (h *NoiseHandshakeInitiator) TransportKeys() (send, recv noiseKey) {
	if !h.done {
		panic("noise: TransportKeys called before handshake complete")
	}
	return h.sendKey, h.recvKey
}

// ─── Handshake State — Responder (Server) ────────────────────────────────────

// NoiseHandshake holds the state for a Noise_XX server-side handshake.
type NoiseHandshake struct {
	ss          *symmetricState
	localStatic NoiseKeyPair    // server's long-term static key
	localEphem  NoiseKeyPair    // server's per-session ephemeral key
	remoteEphem noiseKey        // initiator's ephemeral pubkey (from msg1)
	remoteStatic noiseKey       // initiator's static pubkey (from msg3)
	done        bool
	sendKey     noiseKey
	recvKey     noiseKey
}

// NewNoiseHandshake creates a new server-side Noise_XX handshake.
func NewNoiseHandshake(serverStatic NoiseKeyPair) (*NoiseHandshake, error) {
	// Generate fresh ephemeral key for this session
	ephem, err := GenerateNoiseKeyPair()
	if err != nil {
		return nil, err
	}
	h := &NoiseHandshake{
		ss:          newSymmetricState(),
		localStatic: serverStatic,
		localEphem:  ephem,
	}
	// mixHash(prologue) — empty prologue for this implementation
	h.ss.mixHash([]byte{})
	return h, nil
}

// ReadMsg1 processes the initiator's first message: [e]
// Returns the initiator's ephemeral public key.
func (h *NoiseHandshake) ReadMsg1(msg []byte) error {
	if len(msg) < dhLen {
		return errors.New("noise: msg1 too short")
	}
	copy(h.remoteEphem[:], msg[:dhLen])
	h.ss.mixHash(h.remoteEphem[:])
	return nil
}

// WriteMsg2 builds the responder's second message: [e, ee, s, es]
// This sends the server's ephemeral and encrypted static key.
func (h *NoiseHandshake) WriteMsg2() ([]byte, error) {
	// → e
	h.ss.mixHash(h.localEphem.Public[:])

	// ee: DH(localEphem, remoteEphem)
	ee, err := dh(h.localEphem.Private, h.remoteEphem)
	if err != nil {
		return nil, err
	}
	h.ss.mixKey(ee)

	// s: encrypt server's static public key
	encS, err := h.ss.encryptAndHash(h.localStatic.Public[:])
	if err != nil {
		return nil, err
	}

	// es: DH(localEphem, remoteStatic) — but we don't know remoteStatic yet for XX
	// In XX: es = DH(server_e, client_s) — done in msg3 read
	// Here we do: DH(localEphem, remoteEphem) already done as ee
	// Noise_XX msg2: e, ee, s, es — where es = DH(e_responder, s_initiator)
	// We skip es here as we don't yet have s_initiator — it arrives in msg3.
	// Instead we do s (encrypted static) only. The es DH for msg2 in Noise_XX
	// actually uses the REMOTE STATIC which we DON'T have yet. Let me re-read the spec.
	//
	// After careful re-reading: In XX,
	//   msg2: ← e, ee, s, es
	//   The 'es' here = DH(responder_e, initiator_s)
	//   But initiator_s hasn't been received yet in msg2!
	// This appears contradictory. The resolution: in Noise_XX msg2 processing,
	// 'es' is performed by the INITIATOR (not the responder):
	//   From initiator's perspective: e=local_e, s=remote_s (just received)
	//   So es = DH(initiator_e, responder_s) ... which = DH(responder_s, initiator_e) for responder
	//
	// Let's be precise about the spec:
	// For msg2 token 'es': it's executed from BOTH perspectives simultaneously.
	// Initiator: performs DH(e=their_ephemeral, s=server_static_just_received)
	// Responder: performs DH(s=their_static, e=initiator_ephemeral)
	// Both get the same DH result because DH is symmetric.
	//
	// So responder's es = DH(localStatic, remoteEphem)
	es, err := dh(h.localStatic.Private, h.remoteEphem)
	if err != nil {
		return nil, err
	}
	h.ss.mixKey(es)

	// Build message: [localEphem.Public | encS]
	msg := make([]byte, 0, dhLen+len(encS))
	msg = append(msg, h.localEphem.Public[:]...)
	msg = append(msg, encS...)
	return msg, nil
}

// ReadMsg3 processes the initiator's third message: [s, se]
// Returns nil on success; the handshake is complete after this.
func (h *NoiseHandshake) ReadMsg3(msg []byte) error {
	if len(msg) < dhLen+tagLen {
		return errors.New("noise: msg3 too short")
	}

	// s: decrypt initiator's static public key
	encS := msg[:dhLen+tagLen]
	pt, err := h.ss.decryptAndHash(encS)
	if err != nil {
		return fmt.Errorf("noise: msg3 decrypt s: %w", err)
	}
	copy(h.remoteStatic[:], pt)

	// se: DH(localEphem, remoteStatic)
	se, err := dh(h.localEphem.Private, h.remoteStatic)
	if err != nil {
		return err
	}
	h.ss.mixKey(se)

	// Split into transport keys
	h.sendKey, h.recvKey = h.ss.split()
	h.done = true
	return nil
}

// TransportKeys returns the derived send and receive cipher keys after a
// completed handshake. Panics if handshake is not done.
func (h *NoiseHandshake) TransportKeys() (send, recv noiseKey) {
	if !h.done {
		panic("noise: TransportKeys called before handshake complete")
	}
	return h.sendKey, h.recvKey
}

// RemoteStaticKey returns the initiator's authenticated static public key
// (available after ReadMsg3).
func (h *NoiseHandshake) RemoteStaticKey() noiseKey {
	return h.remoteStatic
}

// ─── Transport Cipher ─────────────────────────────────────────────────────────

// NoiseCipher provides authenticated encryption for post-handshake transport.
type NoiseCipher struct {
	key noiseKey
	n   uint64
}

func NewNoiseCipher(key noiseKey) *NoiseCipher {
	return &NoiseCipher{key: key}
}

func (c *NoiseCipher) Encrypt(plaintext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(c.key[:])
	if err != nil {
		return nil, err
	}
	nonce := buildNonce(c.n)
	c.n++
	return aead.Seal(nil, nonce, plaintext, nil), nil
}

func (c *NoiseCipher) Decrypt(ciphertext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(c.key[:])
	if err != nil {
		return nil, err
	}
	nonce := buildNonce(c.n)
	c.n++
	pt, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("noise: transport decrypt: %w", err)
	}
	return pt, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// hkdf2 implements HKDF-Extract + HKDF-Expand(2 outputs) per Noise spec:
//   HKDF(ck, inputKeyMaterial) → (output1, output2)
func hkdf2(ck, ikm noiseKey) (out1, out2 noiseKey) {
	// Extract
	mac := hmac.New(sha256.New, ck[:])
	mac.Write(ikm[:])
	tempKey := mac.Sum(nil)

	// Expand → output1
	mac = hmac.New(sha256.New, tempKey)
	mac.Write([]byte{0x01})
	copy(out1[:], mac.Sum(nil))

	// Expand → output2
	mac = hmac.New(sha256.New, tempKey)
	mac.Write(out1[:])
	mac.Write([]byte{0x02})
	copy(out2[:], mac.Sum(nil))

	return out1, out2
}

// buildNonce encodes a 64-bit counter into a 96-bit ChaCha20-Poly1305 nonce
// (little-endian, zero-padded in high bytes per Noise spec).
func buildNonce(n uint64) []byte {
	nonce := make([]byte, nonceLen)
	binary.LittleEndian.PutUint64(nonce[4:], n)
	return nonce
}
