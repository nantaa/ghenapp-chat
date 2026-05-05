package ws

import (
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// Client represents one connected plain WebSocket user.
type Client struct {
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte // outbound frame queue
}

// NoiseClient represents a Noise_XX encrypted WebSocket user.
type NoiseClient struct {
	UserID string
	Conn   *NoiseConn
	Send   chan []byte
}

// Hub maintains the registry of all connected clients (plain + Noise).
type Hub struct {
	mu          sync.RWMutex
	clients     map[string]*Client      // userID → plain Client
	noiseClients map[string]*NoiseClient // userID → Noise Client
}

func NewHub() *Hub {
	return &Hub{
		clients:      make(map[string]*Client),
		noiseClients: make(map[string]*NoiseClient),
	}
}

// Register adds a plain client to the hub.
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.clients[c.UserID]; ok {
		close(old.Send)
	}
	h.clients[c.UserID] = c
	log.Printf("[hub] user %s connected (total: %d)", c.UserID, h.totalLocked())
}

// RegisterNoise adds a Noise-encrypted client to the hub.
func (h *Hub) RegisterNoise(c *NoiseClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.noiseClients[c.UserID]; ok {
		close(old.Send)
	}
	h.noiseClients[c.UserID] = c
	log.Printf("[hub/noise] user %s connected (total: %d)", c.UserID, h.totalLocked())
}

// Unregister removes a plain client from the hub.
func (h *Hub) Unregister(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, ok := h.clients[userID]; ok {
		close(c.Send)
		delete(h.clients, userID)
		log.Printf("[hub] user %s disconnected (total: %d)", userID, h.totalLocked())
	}
}

// UnregisterNoise removes a Noise client from the hub.
func (h *Hub) UnregisterNoise(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, ok := h.noiseClients[userID]; ok {
		close(c.Send)
		delete(h.noiseClients, userID)
		log.Printf("[hub/noise] user %s disconnected (total: %d)", userID, h.totalLocked())
	}
}

// IsOnline returns true if the user has an active WebSocket connection (plain or Noise).
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, plain := h.clients[userID]
	_, noise := h.noiseClients[userID]
	return plain || noise
}

// Send queues a frame for delivery to a specific user (plain or Noise).
// Returns false if the user is not connected.
func (h *Hub) Send(userID string, frame []byte) bool {
	h.mu.RLock()
	plain, hasPlain := h.clients[userID]
	noise, hasNoise := h.noiseClients[userID]
	h.mu.RUnlock()

	if hasNoise {
		select {
		case noise.Send <- frame:
			return true
		default:
			h.UnregisterNoise(userID)
			return false
		}
	}
	if hasPlain {
		select {
		case plain.Send <- frame:
			return true
		default:
			h.Unregister(userID)
			return false
		}
	}
	return false
}

// Broadcast sends a frame to a list of user IDs.
func (h *Hub) Broadcast(userIDs []string, frame []byte) {
	for _, uid := range userIDs {
		h.Send(uid, frame)
	}
}

// ConnectedCount returns the number of active connections (plain + Noise).
func (h *Hub) ConnectedCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.totalLocked()
}

func (h *Hub) totalLocked() int {
	return len(h.clients) + len(h.noiseClients)
}
