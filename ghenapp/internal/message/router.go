package message

import (
	"context"
	"fmt"
	"log"
	"time"

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

func parseMsgType(s string) ws.MsgType {
	switch s {
	case "TEXT": return ws.MsgText
	case "IMAGE": return ws.MsgImage
	case "VIDEO": return ws.MsgVideo
	case "AUDIO": return ws.MsgAudio
	case "FILE": return ws.MsgFile
	case "STICKER": return ws.MsgSticker
	case "REACTION": return ws.MsgReaction
	case "SYSTEM": return ws.MsgSystem
	case "CALL_SIGNAL": return ws.MsgCallSignal
	default: return ws.MsgText
	}
}

// Route delivers a message to a recipient.
// Fast path: direct in-process hub.Send() for users connected to this node.
// Slow path: Redis Pub/Sub (multi-node) + PostgreSQL offline queue + Web Push.
// Deliver attempts to send a message to a recipient's active WebSocket,
// or falls back to Redis Pub/Sub and Web Push for offline users.
// Note: This does NOT store the message in the DB. The caller must call StoreOffline once.
func (r *Router) Deliver(ctx context.Context, recipientID string, env *Envelope, rawFrame []byte) error {

	// Fast path: direct delivery if recipient is on this node
	if r.hub.Send(recipientID, rawFrame) {
		log.Printf("[router] direct delivery → %s", recipientID)
		_ = r.queries.MarkMessageDelivered(ctx, env.ID)
		return nil
	}

	// Slow path: Redis pub/sub for other nodes
	channel := pubsubPrefix + recipientID
	if result := r.rdb.Publish(ctx, channel, rawFrame); result.Err() != nil {
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

// StoreOffline persists a message to PostgreSQL for later delivery.
func (r *Router) StoreOffline(ctx context.Context, env *Envelope) error {
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
		SenderID:       uuid.NullUUID{UUID: senderID, Valid: true},
		Payload:        env.Payload,
		MsgType:        env.MsgType,
		Timestamp:      time.UnixMilli(env.Timestamp),
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
			frame := &ws.Frame{
				Version:        ws.IMCPVersion,
				Type:           parseMsgType(m.MsgType),
				ID:             m.ID,
				TimestampMS:    m.Timestamp.UnixMilli(),
				ConversationID: m.ConversationID,
				Payload:        m.Payload,
			}
			rawFrame, err := frame.Encode()
			if err != nil {
				continue
			}
			if r.hub.Send(userID, rawFrame) {
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
		convs, _ := r.queries.GetConversationsForUser(ctx, uid)
		var convIDs []uuid.UUID
		for _, c := range convs {
			convIDs = append(convIDs, c.ID)
		}
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
