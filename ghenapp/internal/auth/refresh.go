package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const sessionPrefix = "session:"

// RefreshService manages opaque refresh tokens in Redis.
type RefreshService struct {
	rdb    *redis.Client
	expiry time.Duration
}

func NewRefreshService(rdb *redis.Client, expiry time.Duration) *RefreshService {
	return &RefreshService{rdb: rdb, expiry: expiry}
}

// Issue generates a new random refresh token and stores it in Redis.
func (s *RefreshService) Issue(ctx context.Context, userID string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("refresh: rand: %w", err)
	}
	token := hex.EncodeToString(b)
	key := sessionPrefix + token
	if err := s.rdb.Set(ctx, key, userID, s.expiry).Err(); err != nil {
		return "", fmt.Errorf("refresh: redis set: %w", err)
	}
	return token, nil
}

// Validate returns the userID for a valid, non-revoked token.
func (s *RefreshService) Validate(ctx context.Context, token string) (string, error) {
	key := sessionPrefix + token
	userID, err := s.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("refresh: token not found or expired")
	}
	if err != nil {
		return "", fmt.Errorf("refresh: redis get: %w", err)
	}
	return userID, nil
}

// Revoke deletes the token from Redis immediately.
func (s *RefreshService) Revoke(ctx context.Context, token string) error {
	return s.rdb.Del(ctx, sessionPrefix+token).Err()
}
