// Package push handles VAPID key management, subscription storage, and
// Web Push notification delivery for offline GhenApp users.
//
// Delivery flow:
//  1. Server generates a P-256 VAPID key pair on first startup, persisted to disk.
//  2. Browser fetches VAPID public key via GET /api/v1/push/vapid-key.
//  3. Browser registers a PushSubscription and POSTs it to /api/v1/push/subscribe.
//  4. message.Router detects a target user has no active WebSocket →
//     calls Service.Notify() which sends a Web Push to all registered subscriptions.
package push

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"
)

// ─── VAPID Key Management ─────────────────────────────────────────────────────

// VAPIDKeys holds the server's VAPID P-256 key pair.
type VAPIDKeys struct {
	Private string `json:"private"` // base64url P-256 private key
	Public  string `json:"public"`  // base64url P-256 public key (sent to clients)
}

// GenerateVAPIDKeys produces a fresh P-256 VAPID key pair.
func GenerateVAPIDKeys() (VAPIDKeys, error) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return VAPIDKeys{}, fmt.Errorf("vapid keygen: %w", err)
	}
	return VAPIDKeys{Private: priv, Public: pub}, nil
}

// LoadOrGenerateVAPIDKeys reads VAPID keys from path, generating and saving
// new ones if the file does not yet exist.
func LoadOrGenerateVAPIDKeys(path string) (VAPIDKeys, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		var k VAPIDKeys
		if err := json.Unmarshal(data, &k); err == nil {
			log.Printf("[push] loaded VAPID keys from %s", path)
			return k, nil
		}
	}
	// Generate fresh keys
	k, err := GenerateVAPIDKeys()
	if err != nil {
		return k, err
	}
	out, _ := json.Marshal(k)
	if wErr := os.WriteFile(path, out, 0600); wErr != nil {
		log.Printf("[push] warning: could not persist VAPID keys to %s: %v", path, wErr)
	}
	log.Printf("[push] generated new VAPID keys, stored at %s", path)
	return k, nil
}

// ─── Subscription types ───────────────────────────────────────────────────────

// Subscription is the browser-provided PushSubscription object.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"` // client public key (base64url)
		Auth   string `json:"auth"`   // auth secret (base64url)
	} `json:"keys"`
}

// NotifyPayload is the JSON body delivered as the push notification payload.
type NotifyPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Icon  string `json:"icon,omitempty"`
	Tag   string `json:"tag,omitempty"` // collapses duplicates per conversation
	URL   string `json:"url,omitempty"` // deep-link on notification click
}

// ─── Service ──────────────────────────────────────────────────────────────────

// Service manages VAPID keys, subscription persistence, and push delivery.
type Service struct {
	db      *sql.DB
	keys    VAPIDKeys
	subject string // VAPID subject: "mailto:you@example.com" or "https://…"
}

// New creates a push Service.
func New(db *sql.DB, keys VAPIDKeys, vapidSubject string) *Service {
	return &Service{db: db, keys: keys, subject: vapidSubject}
}

// PublicKey returns the VAPID public key for the /vapid-key endpoint.
func (s *Service) PublicKey() string { return s.keys.Public }

// ─── Subscription CRUD ────────────────────────────────────────────────────────

// SaveSubscription upserts a browser PushSubscription for a user.
func (s *Service) SaveSubscription(ctx context.Context, userID uuid.UUID, sub Subscription, userAgent string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
		VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		ON CONFLICT (user_id, endpoint) DO UPDATE
		  SET p256dh       = EXCLUDED.p256dh,
		      auth         = EXCLUDED.auth,
		      last_used_at = NOW()
	`, userID, sub.Endpoint, sub.Keys.P256DH, sub.Keys.Auth, userAgent)
	if err != nil {
		return fmt.Errorf("save push sub: %w", err)
	}
	return nil
}

// DeleteSubscription removes a specific endpoint subscription for a user.
func (s *Service) DeleteSubscription(ctx context.Context, userID uuid.UUID, endpoint string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
		userID, endpoint,
	)
	return err
}

// DeleteAllSubscriptions removes all subscriptions for a user (e.g., on logout).
func (s *Service) DeleteAllSubscriptions(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM push_subscriptions WHERE user_id = $1`,
		userID,
	)
	return err
}

// ─── Notification Delivery ────────────────────────────────────────────────────

// Notify sends a Web Push notification to ALL registered subscriptions for a user.
// Stale subscriptions (HTTP 410/404 from push service) are automatically pruned.
func (s *Service) Notify(ctx context.Context, userID uuid.UUID, payload NotifyPayload) error {
	subs, err := s.getSubscriptions(ctx, userID)
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return nil // user has no push registrations — silently skip
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	var stale []string
	for _, sub := range subs {
		ps := &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys: webpush.Keys{
				P256dh: sub.P256DH,
				Auth:   sub.Auth,
			},
		}
		resp, sendErr := webpush.SendNotification(data, ps, &webpush.Options{
			VAPIDPublicKey:  s.keys.Public,
			VAPIDPrivateKey: s.keys.Private,
			Subscriber:      s.subject,
			TTL:             3600, // 1-hour TTL
			Urgency:         webpush.UrgencyHigh,
		})
		if sendErr != nil {
			log.Printf("[push] send error for user %s: %v", userID, sendErr)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == 410 || resp.StatusCode == 404 {
			stale = append(stale, sub.Endpoint)
		}
	}

	// Prune stale subscriptions asynchronously to not block caller
	if len(stale) > 0 {
		go func() {
			for _, ep := range stale {
				if err := s.DeleteSubscription(context.Background(), userID, ep); err != nil {
					log.Printf("[push] prune stale sub: %v", err)
				}
			}
		}()
	}
	return nil
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

type pushSubRow struct {
	Endpoint string
	P256DH   string
	Auth     string
}

func (s *Service) getSubscriptions(ctx context.Context, userID uuid.UUID) ([]pushSubRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pushSubRow
	for rows.Next() {
		var r pushSubRow
		if err := rows.Scan(&r.Endpoint, &r.P256DH, &r.Auth); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

// NotifyNewMessage builds a standard "new message" push payload.
func NotifyNewMessage(senderUsername, conversationID string) NotifyPayload {
	return NotifyPayload{
		Title: "GhenApp",
		Body:  fmt.Sprintf("New message from %s", senderUsername),
		Icon:  "/icon-192.png",
		Tag:   "msg-" + conversationID, // one notification collapsed per conversation
		URL:   "/",
	}
}
