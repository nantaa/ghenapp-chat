package ws

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/curve25519"
)

// LoadOrGenerateNoiseKeyPair loads the server's Noise static key pair from
// keyFile on disk. If the file doesn't exist, generates a fresh key pair,
// writes it to keyFile, and returns it. This ensures the server presents the
// same static public key across restarts so connected clients don't see a
// key mismatch that breaks the Noise_XX handshake.
//
// keyFile format: 64 lowercase hex characters (32-byte private key).
// The public key is always rederived from the private key via X25519.
func LoadOrGenerateNoiseKeyPair(keyFile string) (NoiseKeyPair, error) {
	// ── Try to load existing key ──────────────────────────────────────────────
	data, err := os.ReadFile(keyFile)
	if err == nil {
		hexStr := strings.TrimSpace(string(data))
		privBytes, decErr := hex.DecodeString(hexStr)
		if decErr != nil || len(privBytes) != 32 {
			return NoiseKeyPair{}, fmt.Errorf("noise: key file %q is corrupt (want 64 hex chars): %w", keyFile, decErr)
		}
		var priv noiseKey
		copy(priv[:], privBytes)
		return keypairFromPrivate(priv)
	}
	if !os.IsNotExist(err) {
		return NoiseKeyPair{}, fmt.Errorf("noise: read key file %q: %w", keyFile, err)
	}

	// ── Generate fresh key and persist it ────────────────────────────────────
	kp, err := GenerateNoiseKeyPair()
	if err != nil {
		return kp, err
	}
	hexPriv := hex.EncodeToString(kp.Private[:]) + "\n"
	if writeErr := os.WriteFile(keyFile, []byte(hexPriv), 0600); writeErr != nil {
		// Log but don't fatal — key is still valid this session.
		fmt.Printf("[noise] WARNING: could not save key to %q: %v\n", keyFile, writeErr)
	}
	return kp, nil
}

// keypairFromPrivate rederives the full NoiseKeyPair from a 32-byte private key.
func keypairFromPrivate(priv noiseKey) (NoiseKeyPair, error) {
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return NoiseKeyPair{}, fmt.Errorf("noise: rederive pubkey: %w", err)
	}
	var kp NoiseKeyPair
	kp.Private = priv
	copy(kp.Public[:], pub)
	return kp, nil
}
