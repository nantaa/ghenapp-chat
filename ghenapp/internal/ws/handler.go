package ws

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 2 * 1024 * 1024 // 2MB
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for prototype; restrict in production
	},
}

// Handler manages WebSocket connections.
type Handler struct {
	hub      *Hub
	onFrame  func(userID string, frame []byte) // callback when a frame arrives
}

func NewHandler(hub *Hub, onFrame func(userID string, frame []byte)) *Handler {
	return &Handler{hub: hub, onFrame: onFrame}
}

// ServeWS upgrades the HTTP connection and starts read/write pumps.
// The JWT token is passed as query param: /ws?token=<jwt>
// (WebSocket handshake cannot set custom headers from browser)
func (h *Handler) ServeWS(c *gin.Context) {
	userID, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	uid := userID.(string)

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[ws] upgrade error for %s: %v", uid, err)
		return
	}

	client := &Client{
		UserID: uid,
		Conn:   conn,
		Send:   make(chan []byte, 256),
	}
	h.hub.Register(client)

	// Start pumps in goroutines
	go h.writePump(client)
	go h.readPump(client)
}

// readPump reads frames from the WebSocket connection.
func (h *Handler) readPump(c *Client) {
	defer func() {
		h.hub.Unregister(c.UserID)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, frame, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[ws] read error for %s: %v", c.UserID, err)
			}
			break
		}
		if h.onFrame != nil {
			h.onFrame(c.UserID, frame)
		}
	}
}

// writePump sends queued frames to the WebSocket connection and sends pings.
func (h *Handler) writePump(c *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case frame, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				log.Printf("[ws] write error for %s: %v", c.UserID, err)
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
