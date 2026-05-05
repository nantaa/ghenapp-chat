package ws_test

import (
	"crypto/rand"
	"io"
	"testing"

	"github.com/ghenapp/ghenapp/internal/ws"
)

// ─── Key Generation ───────────────────────────────────────────────────────────

func TestGenerateNoiseKeyPair(t *testing.T) {
	kp, err := ws.GenerateNoiseKeyPair()
	if err != nil {
		t.Fatalf("GenerateNoiseKeyPair: %v", err)
	}
	if kp.Public == (ws.NoiseKey{}) {
		t.Error("public key is zero")
	}
	if kp.Private == (ws.NoiseKey{}) {
		t.Error("private key is zero")
	}
	// Two keys must be different
	kp2, _ := ws.GenerateNoiseKeyPair()
	if kp.Public == kp2.Public {
		t.Error("two generated keys are identical")
	}
}

// ─── Full Handshake (Initiator + Responder) ───────────────────────────────────

func TestNoiseXX_FullHandshake(t *testing.T) {
	// Generate static keys for both sides
	serverStatic, err := ws.GenerateNoiseKeyPair()
	if err != nil {
		t.Fatalf("server keygen: %v", err)
	}
	clientStatic, err := ws.GenerateNoiseKeyPair()
	if err != nil {
		t.Fatalf("client keygen: %v", err)
	}

	// ── Client side (initiator) ──
	clientHS, err := ws.NewNoiseHandshakeInitiator(clientStatic, serverStatic.Public)
	if err != nil {
		t.Fatalf("client HS init: %v", err)
	}

	// ── Server side (responder) ──
	serverHS, err := ws.NewNoiseHandshake(serverStatic)
	if err != nil {
		t.Fatalf("server HS init: %v", err)
	}

	// Message 1: client → server [e]
	msg1, err := clientHS.WriteMsg1()
	if err != nil {
		t.Fatalf("WriteMsg1: %v", err)
	}
	if err := serverHS.ReadMsg1(msg1); err != nil {
		t.Fatalf("ReadMsg1: %v", err)
	}

	// Message 2: server → client [e, ee, s, es]
	msg2, err := serverHS.WriteMsg2()
	if err != nil {
		t.Fatalf("WriteMsg2: %v", err)
	}
	if err := clientHS.ReadMsg2(msg2); err != nil {
		t.Fatalf("ReadMsg2: %v", err)
	}

	// Message 3: client → server [s, se]
	msg3, err := clientHS.WriteMsg3()
	if err != nil {
		t.Fatalf("WriteMsg3: %v", err)
	}
	if err := serverHS.ReadMsg3(msg3); err != nil {
		t.Fatalf("ReadMsg3: %v", err)
	}

	// Both sides derive transport keys
	clientSend, clientRecv := clientHS.TransportKeys()
	serverRecv, serverSend := serverHS.TransportKeys()

	// Client send == Server recv
	if clientSend != serverRecv {
		t.Error("client send key != server recv key")
	}
	// Client recv == Server send
	if clientRecv != serverSend {
		t.Error("client recv key != server send key")
	}
}

// ─── Transport Cipher ─────────────────────────────────────────────────────────

func TestNoiseCipher_EncryptDecrypt(t *testing.T) {
	var key ws.NoiseKey
	if _, err := io.ReadFull(rand.Reader, key[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}

	enc := ws.NewNoiseCipher(key)
	dec := ws.NewNoiseCipher(key)

	plaintext := []byte("Hello, Noise transport!")
	ct, err := enc.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if string(ct) == string(plaintext) {
		t.Error("ciphertext equals plaintext")
	}

	pt, err := dec.Decrypt(ct)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if string(pt) != string(plaintext) {
		t.Errorf("plaintext mismatch: got %q want %q", pt, plaintext)
	}
}

func TestNoiseCipher_NonceAdvances(t *testing.T) {
	var key ws.NoiseKey
	io.ReadFull(rand.Reader, key[:])
	enc := ws.NewNoiseCipher(key)

	ct1, _ := enc.Encrypt([]byte("msg1"))
	ct2, _ := enc.Encrypt([]byte("msg2"))
	if string(ct1) == string(ct2) {
		t.Error("same ciphertext for different messages (nonce not advancing?)")
	}
}

func TestNoiseCipher_WrongKeyFails(t *testing.T) {
	var key1, key2 ws.NoiseKey
	io.ReadFull(rand.Reader, key1[:])
	io.ReadFull(rand.Reader, key2[:])

	ct, _ := ws.NewNoiseCipher(key1).Encrypt([]byte("secret"))
	_, err := ws.NewNoiseCipher(key2).Decrypt(ct)
	if err == nil {
		t.Error("expected decryption error with wrong key, got nil")
	}
}

func TestNoiseCipher_TamperedCiphertextFails(t *testing.T) {
	var key ws.NoiseKey
	io.ReadFull(rand.Reader, key[:])
	ct, _ := ws.NewNoiseCipher(key).Encrypt([]byte("message"))
	ct[0] ^= 0xFF // flip bits
	_, err := ws.NewNoiseCipher(key).Decrypt(ct)
	if err == nil {
		t.Error("expected authentication error for tampered ciphertext")
	}
}
