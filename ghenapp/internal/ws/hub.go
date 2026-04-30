package ws

import (
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// Client represents one connected WebSocket user.
type Client struct {
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte // outbound frame queue
}

// Hub maintains the registry of all connected clients.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client // userID → Client
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]*Client)}
}

// Register adds a client to the hub.
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// If user reconnects, close old connection first
	if old, ok := h.clients[c.UserID]; ok {
		close(old.Send)
	}
	h.clients[c.UserID] = c
	log.Printf("[hub] user %s connected (total: %d)", c.UserID, len(h.clients))
}

// Unregister removes a client from the hub.
func (h *Hub) Unregister(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, ok := h.clients[userID]; ok {
		close(c.Send)
		delete(h.clients, userID)
		log.Printf("[hub] user %s disconnected (total: %d)", userID, len(h.clients))
	}
}

// IsOnline returns true if the user has an active WebSocket connection.
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.clients[userID]
	return ok
}

// Send queues a frame for delivery to a specific user.
// Returns false if the user is not connected.
func (h *Hub) Send(userID string, frame []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	select {
	case c.Send <- frame:
		return true
	default:
		// Send buffer full — drop and disconnect
		h.Unregister(userID)
		return false
	}
}

// Broadcast sends a frame to a list of user IDs (for group messages).
func (h *Hub) Broadcast(userIDs []string, frame []byte) {
	for _, uid := range userIDs {
		h.Send(uid, frame)
	}
}

// ConnectedCount returns the number of active connections.
func (h *Hub) ConnectedCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
