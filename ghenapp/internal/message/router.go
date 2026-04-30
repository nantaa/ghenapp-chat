package message

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/ghenapp/ghenapp/internal/db"
	"github.com/ghenapp/ghenapp/internal/ws"
	"github.com/redis/go-redis/v9"
)

const pubsubPrefix = "imcp:user:"

// Router handles message delivery — online via Redis Pub/Sub, offline via DB queue.
type Router struct {
	hub     *ws.Hub
	rdb     *redis.Client
	queries *db.Queries
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

// Route delivers a message to a recipient.
// If online: push via WebSocket. If offline: queue in PostgreSQL.
func (r *Router) Route(ctx context.Context, recipientID string, env *Envelope) error {
	frame, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("router: marshal: %w", err)
	}

	// Try online delivery first via Redis Pub/Sub
	channel := pubsubPrefix + recipientID
	result := r.rdb.Publish(ctx, channel, frame)
	if result.Err() != nil {
		log.Printf("[router] redis publish error: %v", result.Err())
	}

	// If recipient not connected to THIS server node, also store for offline delivery
	if !r.hub.IsOnline(recipientID) {
		if err := r.storeOffline(ctx, env); err != nil {
			log.Printf("[router] offline store error: %v", err)
		}
	}
	return nil
}

// storeOffline persists a message to PostgreSQL for later delivery.
func (r *Router) storeOffline(ctx context.Context, env *Envelope) error {
	var convID [16]byte
	copy(convID[:], env.ConversationID)
	var senderID [16]byte
	copy(senderID[:], env.SenderID)

	_, err := r.queries.InsertMessage(ctx, db.InsertMessageParams{
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
func (r *Router) DeliverPending(ctx context.Context, userID string, convIDs [][16]byte) {
	for _, cid := range convIDs {
		msgs, err := r.queries.GetUndeliveredMessages(ctx, cid)
		if err != nil {
			continue
		}
		for _, m := range msgs {
			frame, _ := json.Marshal(Envelope{
				ID:             m.ID,
				ConversationID: string(m.ConversationID[:]),
				SenderID:       string(m.SenderID[:]),
				Payload:        m.Payload,
				MsgType:        m.MsgType,
				Timestamp:      m.Timestamp,
			})
			if r.hub.Send(userID, frame) {
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
