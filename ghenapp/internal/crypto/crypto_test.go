package crypto_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/ghenapp/ghenapp/internal/crypto"
)

// ─── VerifySignedPrekey ───────────────────────────────────────────────────────

func TestVerifySignedPrekey_Valid(t *testing.T) {
	// Generate identity keypair
	identityPub, identityPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	// Generate signed prekey
	spkPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("spk keygen: %v", err)
	}
	// Sign the SPK with identity key
	sig := ed25519.Sign(identityPriv, spkPub)

	if err := crypto.VerifySignedPrekey(identityPub, spkPub, sig); err != nil {
		t.Errorf("expected valid signature, got error: %v", err)
	}
}

func TestVerifySignedPrekey_InvalidSignature(t *testing.T) {
	identityPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	spkPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("spk keygen: %v", err)
	}
	// Use wrong signature (all zeros)
	badSig := make([]byte, ed25519.SignatureSize)
	if err := crypto.VerifySignedPrekey(identityPub, spkPub, badSig); err == nil {
		t.Error("expected error for bad signature, got nil")
	}
}

func TestVerifySignedPrekey_WrongKey(t *testing.T) {
	// Sign with key A, verify with key B
	_, identityPrivA, _ := ed25519.GenerateKey(rand.Reader)
	identityPubB, _, _  := ed25519.GenerateKey(rand.Reader)
	spkPub, _, _         := ed25519.GenerateKey(rand.Reader)

	sig := ed25519.Sign(identityPrivA, spkPub)
	if err := crypto.VerifySignedPrekey(identityPubB, spkPub, sig); err == nil {
		t.Error("expected error for mismatched key, got nil")
	}
}

func TestVerifySignedPrekey_ShortKey(t *testing.T) {
	err := crypto.VerifySignedPrekey([]byte{0x01, 0x02}, []byte("spk"), []byte("sig"))
	if err == nil {
		t.Error("expected error for short identity key")
	}
}

// ─── VerifyLoginChallenge ─────────────────────────────────────────────────────

func TestVerifyLoginChallenge_Valid(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	challenge := []byte("ghenapp-login:alice:1714900000")
	sig := ed25519.Sign(priv, challenge)

	if err := crypto.VerifyLoginChallenge(pub, challenge, sig); err != nil {
		t.Errorf("expected valid, got: %v", err)
	}
}

func TestVerifyLoginChallenge_Invalid(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	challenge := []byte("ghenapp-login:alice:1714900000")
	badSig := make([]byte, ed25519.SignatureSize)

	if err := crypto.VerifyLoginChallenge(pub, challenge, badSig); err == nil {
		t.Error("expected error for invalid sig")
	}
}

// ─── RandomToken ──────────────────────────────────────────────────────────────

func TestRandomToken_Length(t *testing.T) {
	token, err := crypto.RandomToken(32)
	if err != nil {
		t.Fatalf("RandomToken: %v", err)
	}
	if len(token) == 0 {
		t.Error("expected non-empty token")
	}
}

func TestRandomToken_Uniqueness(t *testing.T) {
	tokens := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		tok, err := crypto.RandomToken(16)
		if err != nil {
			t.Fatalf("RandomToken: %v", err)
		}
		if _, exists := tokens[tok]; exists {
			t.Errorf("duplicate token generated: %s", tok)
		}
		tokens[tok] = struct{}{}
	}
}
