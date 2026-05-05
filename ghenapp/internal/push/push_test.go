package push_test

import (
	"strings"
	"testing"

	"github.com/ghenapp/ghenapp/internal/push"
)

// ─── VAPID Key Generation ─────────────────────────────────────────────────────

func TestGenerateVAPIDKeys_NonEmpty(t *testing.T) {
	k, err := push.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	if k.Public == "" || k.Private == "" {
		t.Error("expected non-empty VAPID keys")
	}
}

func TestGenerateVAPIDKeys_Unique(t *testing.T) {
	k1, _ := push.GenerateVAPIDKeys()
	k2, _ := push.GenerateVAPIDKeys()
	if k1.Public == k2.Public {
		t.Error("two generated key pairs have the same public key")
	}
}

func TestGenerateVAPIDKeys_Base64Format(t *testing.T) {
	k, _ := push.GenerateVAPIDKeys()
	// VAPID keys are base64url — no padding, no +/
	for _, bad := range []string{"+", "/", "="} {
		if strings.Contains(k.Public, bad) {
			t.Errorf("public key contains non-base64url char %q: %s", bad, k.Public)
		}
	}
}

// ─── NotifyNewMessage ─────────────────────────────────────────────────────────

func TestNotifyNewMessage_Fields(t *testing.T) {
	p := push.NotifyNewMessage("alice", "conv-123")
	if p.Title != "GhenApp" {
		t.Errorf("unexpected title: %q", p.Title)
	}
	if p.Body == "" {
		t.Error("body must not be empty")
	}
	if p.Tag != "msg-conv-123" {
		t.Errorf("unexpected tag: %q, want %q", p.Tag, "msg-conv-123")
	}
}

func TestNotifyNewMessage_IncludesSender(t *testing.T) {
	p := push.NotifyNewMessage("bob", "c1")
	if !strings.Contains(p.Body, "bob") {
		t.Errorf("body %q does not mention sender 'bob'", p.Body)
	}
}

func TestNotifyNewMessage_ConversationTag(t *testing.T) {
	p1 := push.NotifyNewMessage("x", "conv-A")
	p2 := push.NotifyNewMessage("y", "conv-A")
	if p1.Tag != p2.Tag {
		t.Error("messages for same conversation should share a tag (for collapse)")
	}
	p3 := push.NotifyNewMessage("x", "conv-B")
	if p1.Tag == p3.Tag {
		t.Error("messages for different conversations must have different tags")
	}
}
