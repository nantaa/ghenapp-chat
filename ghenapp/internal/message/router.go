package message

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/ghenapp/ghenapp/internal/db"
	"github.com/ghenapp/ghenapp/internal/push"
	"github.com/ghenapp/ghenapp/internal/ws"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const pubsubPrefix = "imcp:user:"

// Router handles message delivery — online via Redis Pub/Sub, offline via DB queue + Web Push.
type Router struct {
	hub     *ws.Hub
	rdb     *redis.Client
	queries *db.Queries
	pushSvc *push.Service // may be nil if push not configured
}

// Envelope is the in-memory representation of an IMCP message frame.
type Envelope struct {
	ID             int64  `json:"id"`
	ConversationID string `json:"cid"`
	SenderID       string `json:"sid"`
	Payload        []byte `json:"payload"` // encrypted blob — never inspected
	MsgType        string `json:"type"`
	Timestamp      int64  `json:"ts"`
	TTLSeconds     uint32 `json:"ttl,omitempty"`
}

func NewRouter(hub *ws.Hub, rdb *redis.Client, queries *db.Queries) *Router {
	return &Router{hub: hub, rdb: rdb, queries: queries}
}

// SetPushService attaches a push notification service for offline delivery.
func (r *Router) SetPushService(svc *push.Service) { r.pushSvc = svc }

// buildJSONFrame serialises an Envelope to the JSON wire format understood
// by the frontend's parseJSONEnvelope. The JSON format includes the sender ID
// (sid) which the binary IMCP frame format lacks.
func buildJSONFrame(env *Envelope) ([]byte, error) {
	type wire struct {
		ID      int64  `json:"id"`
		CID     string `json:"cid"`
		SID     string `json:"sid"`
		Type    string `json:"type"`
		Payload []byte `json:"payload"`
		TS      int64  `json:"ts"`
		TTL     uint32 `json:"ttl,omitempty"`
	}
	return json.Marshal(wire{
		ID:      env.ID,
		CID:     env.ConversationID,
		SID:     env.SenderID,
		Type:    env.MsgType,
		Payload: env.Payload,
		TS:      env.Timestamp,
		TTL:     env.TTLSeconds,
	})
}

// Route delivers a message to a recipient.
// Fast path: direct in-process hub.Send() for users connected to this node.
// Slow path: Redis Pub/Sub (multi-node) + PostgreSQL offline queue + Web Push.
// All wire delivery uses JSON so the client receives the sender_id (sid) field.
func (r *Router) Route(ctx context.Context, recipientID string, env *Envelope, rawFrame []byte) error {
	jsonFrame, err := buildJSONFrame(env)
	if err != nil {
		log.Printf("[router] json frame build error: %v", err)
		jsonFrame = rawFrame
	}

	// Always persist every message to DB for history/reload support
	if err := r.storeOffline(ctx, env); err != nil {
		log.Printf("[router] db store error: %v", err)
	}

	// Fast path: direct delivery if recipient is on this node
	if r.hub.Send(recipientID, jsonFrame) {
		log.Printf("[router] direct delivery → %s", recipientID)
		_ = r.queries.MarkMessageDelivered(ctx, env.ID)
		return nil
	}

	// Slow path: Redis pub/sub for other nodes
	channel := pubsubPrefix + recipientID
	if result := r.rdb.Publish(ctx, channel, jsonFrame); result.Err() != nil {
		log.Printf("[router] redis publish error: %v", result.Err())
	}

	// Web Push for truly offline users
	if r.pushSvc != nil {
		recipUID, parseErr := uuid.Parse(recipientID)
		if parseErr == nil {
			payload := push.NotifyNewMessage(env.SenderID, env.ConversationID)
			go func() {
				if err := r.pushSvc.Notify(context.Background(), recipUID, payload); err != nil {
					log.Printf("[router] push notify error: %v", err)
				}
			}()
		}
	}
	return nil
}

// storeOffline persists a message to PostgreSQL for later delivery.
func (r *Router) storeOffline(ctx context.Context, env *Envelope) error {
	convID, err := uuid.Parse(env.ConversationID)
	if err != nil {
		return fmt.Errorf("router: invalid conversation id: %w", err)
	}
	senderID, err := uuid.Parse(env.SenderID)
	if err != nil {
		return fmt.Errorf("router: invalid sender id: %w", err)
	}

	_, err = r.queries.InsertMessage(ctx, db.InsertMessageParams{
		ID:             env.ID,
		ConversationID: convID,
		SenderID:       senderID,
		Payload:        env.Payload,
		MsgType:        env.MsgType,
		Timestamp:      env.Timestamp,
	})
	return err
}

// DeliverPending fetches and delivers all undelivered messages for a user's conversations.
func (r *Router) DeliverPending(ctx context.Context, userID string, convIDs []uuid.UUID) {
	for _, cid := range convIDs {
		msgs, err := r.queries.GetUndeliveredMessages(ctx, cid)
		if err != nil {
			continue
		}
		for _, m := range msgs {
			env := &Envelope{
				ID:             m.ID,
				ConversationID: m.ConversationID.String(),
				SenderID:       m.SenderID.String(),
				Payload:        m.Payload,
				MsgType:        m.MsgType,
				Timestamp:      m.Timestamp,
			}
			jsonFrame, err := buildJSONFrame(env)
			if err != nil {
				continue
			}
			if r.hub.Send(userID, jsonFrame) {
				_ = r.queries.MarkMessageDelivered(ctx, m.ID)
			}
		}
	}
}

// SubscribeAndForward subscribes to Redis Pub/Sub for a user and forwards frames to their WebSocket.
// Runs until ctx is cancelled (call on WS connect; cancel on disconnect).
func (r *Router) SubscribeAndForward(ctx context.Context, userID string) {
	channel := pubsubPrefix + userID
	sub := r.rdb.Subscribe(ctx, channel)
	defer sub.Close()

	// In SubscribeAndForward, before the listen loop:
	uid, err := uuid.Parse(userID)
	if err == nil {
		convIDs, _ := r.queries.GetUserConversations(ctx, uid)
		r.DeliverPending(ctx, userID, convIDs)
	}

	ch := sub.Channel()
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			r.hub.Send(userID, []byte(msg.Payload))
		case <-ctx.Done():
			return
		}
	}
}
