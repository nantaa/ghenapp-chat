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

// Route delivers a message to a recipient.
// If online: push via WebSocket. If offline: queue in PostgreSQL.
func (r *Router) Route(ctx context.Context, recipientID string, env *Envelope, rawFrame []byte) error {
	// Try online delivery first via Redis Pub/Sub
	channel := pubsubPrefix + recipientID
	result := r.rdb.Publish(ctx, channel, rawFrame)
	if result.Err() != nil {
		log.Printf("[router] redis publish error: %v", result.Err())
	}

	// If recipient not connected to THIS server node, also store + push notify
	if !r.hub.IsOnline(recipientID) {
		if err := r.storeOffline(ctx, env); err != nil {
			log.Printf("[router] offline store error: %v", err)
		}
		// Web Push notification for truly offline users
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
			// Convert ConversationID UUID to [16]byte
			cidBytes, _ := m.ConversationID.MarshalBinary()
			var cidArray [16]byte
			copy(cidArray[:], cidBytes)

			// Map string MsgType to ws.MsgType
			var msgType ws.MsgType
			switch m.MsgType {
			case "TEXT":
				msgType = ws.MsgText
			case "IMAGE":
				msgType = ws.MsgImage
			case "VIDEO":
				msgType = ws.MsgVideo
			case "AUDIO":
				msgType = ws.MsgAudio
			case "FILE":
				msgType = ws.MsgFile
			case "STICKER":
				msgType = ws.MsgSticker
			case "REACTION":
				msgType = ws.MsgReaction
			case "CALL_SIGNAL":
				msgType = ws.MsgCallSignal
			default:
				msgType = ws.MsgSystem
			}

			frame := &ws.Frame{
				Version:        ws.IMCPVersion,
				Type:           msgType,
				ID:             m.ID,
				TimestampMS:    m.Timestamp,
				ConversationID: cidArray,
				Payload:        m.Payload,
			}
			rawFrame, _ := frame.Encode()

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
