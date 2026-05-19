package ws

import (
	"context"
	"fmt"
	"log"

	"github.com/ghenapp/ghenapp/internal/db"
	"golang.org/x/crypto/curve25519"
)

// LoadOrGenerateNoiseKeyPair loads the server's Noise static key pair from
// the database. If it doesn't exist, generates a fresh key pair,
// writes it to the database, and returns it. This ensures the server presents the
// same static public key across restarts so connected clients don't see a
// key mismatch that breaks the Noise_XX handshake.
func LoadOrGenerateNoiseKeyPair(ctx context.Context, queries *db.Queries) (NoiseKeyPair, error) {
	// ── Try to load existing key ──────────────────────────────────────────────
	keyData, err := queries.GetServerKey(ctx, "noise_static_key")
	if err == nil {
		if len(keyData) != 32 {
			return NoiseKeyPair{}, fmt.Errorf("noise: key in db is corrupt (want 32 bytes)")
		}
		var priv noiseKey
		copy(priv[:], keyData)
		return keypairFromPrivate(priv)
	}

	// ── Generate fresh key and persist it ────────────────────────────────────
	kp, err := GenerateNoiseKeyPair()
	if err != nil {
		return kp, err
	}
	
	err = queries.SetServerKey(ctx, db.SetServerKeyParams{
		ID:      "noise_static_key",
		KeyData: kp.Private[:],
	})
	if err != nil {
		// Log but don't fatal — key is still valid this session.
		log.Printf("[noise] WARNING: could not save key to db: %v\n", err)
	} else {
		log.Printf("[noise] generated and saved new Noise static key to database")
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
