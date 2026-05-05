// Package crypto provides server-side cryptographic verification utilities.
//
// DESIGN PRINCIPLE: The GhenApp server is intentionally NOT capable of
// decrypting message payloads. All E2E encryption (X3DH + Double Ratchet)
// happens exclusively on clients. This package only handles:
//
//   1. Ed25519 signature verification (prekey authenticity)
//   2. Random nonce/token generation (for API tokens, invite links)
//   3. Documentation of what the server explicitly refuses to do
package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// ─── Ed25519 Verification ─────────────────────────────────────────────────────

// VerifySignedPrekey verifies that a signed prekey was signed by the given
// identity public key. This ensures the signed prekey belongs to the user
// who registered the identity key.
func VerifySignedPrekey(identityPublicKey, signedPrekeyPublic, signature []byte) error {
	if len(identityPublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("identity key must be %d bytes", ed25519.PublicKeySize)
	}
	if len(signedPrekeyPublic) != ed25519.PublicKeySize {
		return fmt.Errorf("signed prekey must be %d bytes", ed25519.PublicKeySize)
	}
	if !ed25519.Verify(ed25519.PublicKey(identityPublicKey), signedPrekeyPublic, signature) {
		return errors.New("signed prekey signature invalid")
	}
	return nil
}

// VerifyLoginChallenge verifies an Ed25519 signature over the standard login challenge.
// Challenge format: "ghenapp-login:{username}:{unix_minute}"
func VerifyLoginChallenge(identityPublicKey []byte, challenge, signature []byte) error {
	if len(identityPublicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public key size: %d", len(identityPublicKey))
	}
	if !ed25519.Verify(ed25519.PublicKey(identityPublicKey), challenge, signature) {
		return errors.New("signature verification failed")
	}
	return nil
}

// ─── Token Generation ─────────────────────────────────────────────────────────

// RandomToken generates a cryptographically secure URL-safe random token.
func RandomToken(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ─── What the Server Intentionally Cannot Do ─────────────────────────────────
//
// The following operations are by design IMPOSSIBLE on the server:
//
//   - Decrypt message payloads (the `payload` column in `messages` is
//     always an opaque BYTEA blob — the server never holds decryption keys)
//
//   - Derive Double Ratchet message keys (all ratchet state is client-only,
//     persisted in the browser's IndexedDB, never transmitted to the server)
//
//   - Perform X3DH key agreement (the server only stores public prekeys;
//     the DH operations happen client-side with private keys that never
//     leave the client device)
//
//   - Read one-time prekeys (the server marks them as "used" but never
//     stores the corresponding private halves — only clients have those)
//
// This is enforced architecturally: private keys are never sent to or
// stored by any server endpoint.
