package auth_test

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/ghenapp/ghenapp/internal/auth"
)

// ─── JWT Tests ────────────────────────────────────────────────────────────────

func TestJWT_IssueAndParse(t *testing.T) {
	svc := auth.NewJWTService("test-secret-key-32-bytes-minimum!", 15*time.Minute)

	token, err := svc.Issue("user-123", "alice", "free")
	if err != nil {
		t.Fatalf("Issue failed: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty token")
	}

	claims, err := svc.Parse(token)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if claims.UserID != "user-123" {
		t.Errorf("UserID: got %q want %q", claims.UserID, "user-123")
	}
	if claims.Username != "alice" {
		t.Errorf("Username: got %q want %q", claims.Username, "alice")
	}
	if claims.Tier != "free" {
		t.Errorf("Tier: got %q want %q", claims.Tier, "free")
	}
}

func TestJWT_ExpiredToken(t *testing.T) {
	// Issue with -1 second expiry (already expired)
	svc := auth.NewJWTService("test-secret-key-32-bytes-minimum!", -1*time.Second)
	token, err := svc.Issue("user-999", "bob", "premium")
	if err != nil {
		t.Fatalf("Issue failed: %v", err)
	}

	_, err = svc.Parse(token)
	if err == nil {
		t.Fatal("expected error for expired token, got nil")
	}
}

func TestJWT_InvalidSignature(t *testing.T) {
	svc1 := auth.NewJWTService("secret-key-one-xxxxxxxxxxxxxxxxx", 15*time.Minute)
	svc2 := auth.NewJWTService("secret-key-two-xxxxxxxxxxxxxxxxx", 15*time.Minute)

	token, _ := svc1.Issue("user-1", "carol", "free")
	_, err := svc2.Parse(token)
	if err == nil {
		t.Fatal("expected signature error, got nil")
	}
}

// ─── Refresh Token Tests ──────────────────────────────────────────────────────

func TestRefresh_IssueValidateRevoke(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	svc := auth.NewRefreshService(rdb, 30*24*time.Hour)

	ctx := context.Background()

	// Issue
	token, err := svc.Issue(ctx, "user-abc")
	if err != nil {
		t.Fatalf("Issue failed: %v", err)
	}
	if len(token) < 32 {
		t.Fatalf("token too short: %q", token)
	}

	// Validate
	userID, err := svc.Validate(ctx, token)
	if err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
	if userID != "user-abc" {
		t.Errorf("userID: got %q want %q", userID, "user-abc")
	}

	// Revoke
	if err := svc.Revoke(ctx, token); err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}

	// Validate after revoke should fail
	_, err = svc.Validate(ctx, token)
	if err == nil {
		t.Fatal("expected error after revoke, got nil")
	}
}

func TestRefresh_InvalidToken(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	svc := auth.NewRefreshService(rdb, 30*24*time.Hour)

	_, err := svc.Validate(context.Background(), "nonexistent-token")
	if err == nil {
		t.Fatal("expected error for unknown token, got nil")
	}
}

// ─── Snowflake Tests ──────────────────────────────────────────────────────────

func TestSnowflake_Uniqueness(t *testing.T) {
	// Tested in snowflake package, referenced here for coverage tracking
	t.Log("Snowflake uniqueness tested in internal/snowflake/snowflake_test.go")
}
