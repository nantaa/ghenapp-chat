package ws

import (
	"context"
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

// Handler manages WebSocket connections with optional Noise_XX transport encryption.
type Handler struct {
	hub          *Hub
	onFrame      func(userID string, frame []byte)
	onConnect    func(ctx context.Context, userID string) // ADD
	serverStatic *NoiseKeyPair
	noiseEnabled bool
}

func NewHandler(hub *Hub, onFrame func(userID string, frame []byte)) *Handler {
	return &Handler{hub: hub, onFrame: onFrame}
}

func (h *Handler) SetOnConnect(fn func(ctx context.Context, userID string)) {
	h.onConnect = fn
}

// EnableNoise configures the handler to perform a Noise_XX handshake
// before accepting IMCP frames. Call this during server initialisation.
func (h *Handler) EnableNoise(kp NoiseKeyPair) {
	h.serverStatic = &kp
	h.noiseEnabled = true
	log.Printf("[ws] Noise_XX transport enabled (server pubkey: %x…)", kp.Public[:4])
}

// ServerPublicKey returns the server's Noise static public key (hex) for
// the /api/v1/noise/pubkey endpoint.
func (h *Handler) ServerPublicKey() []byte {
	if h.serverStatic == nil {
		return nil
	}
	b := make([]byte, 32)
	copy(b, h.serverStatic.Public[:])
	return b
}

// ServeWS upgrades the HTTP connection, optionally performs Noise_XX handshake,
// then starts read/write pumps.
// The JWT token is passed as query param: /ws?token=<jwt>
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

	if h.noiseEnabled && h.serverStatic != nil {
		// Perform Noise_XX handshake — wraps conn in encrypted transport
		nc, err := PerformServerHandshake(conn, *h.serverStatic)
		if err != nil {
			log.Printf("[ws] Noise handshake failed for %s: %v", uid, err)
			conn.Close()
			return
		}
		log.Printf("[ws] Noise_XX established for %s", uid)

		client := &NoiseClient{
			UserID: uid,
			Conn:   nc,
			Send:   make(chan []byte, 256),
		}
		h.hub.RegisterNoise(client)
		ctx, cancel := context.WithCancel(context.Background())
		go func() { defer cancel(); h.noiseWritePump(client) }()
		go h.noiseReadPump(client)
			if h.onConnect != nil {
			    go h.onConnect(ctx, uid)
			}
		return
	}

	// Plain WebSocket (no Noise) — for dev / backwards compat
	client := &Client{
		UserID: uid,
		Conn:   conn,
		Send:   make(chan []byte, 256),
	}
	h.hub.Register(client)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { defer cancel(); h.writePump(client) }()
	go h.readPump(client)
		if h.onConnect != nil {
		    go h.onConnect(ctx, uid)
		}
	}

// ─── Plain WS pumps ───────────────────────────────────────────────────────────

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

// ─── Noise WS pumps ───────────────────────────────────────────────────────────

func (h *Handler) noiseReadPump(c *NoiseClient) {
	defer func() {
		h.hub.UnregisterNoise(c.UserID)
		c.Conn.Close()
	}()

	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		frame, err := c.Conn.ReadFrame()
		if err != nil {
			log.Printf("[ws/noise] read error for %s: %v", c.UserID, err)
			break
		}
		if h.onFrame != nil {
			h.onFrame(c.UserID, frame)
		}
	}
}

func (h *Handler) noiseWritePump(c *NoiseClient) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case frame, ok := <-c.Send:
			if !ok {
				return
			}
			if err := c.Conn.WriteFrame(frame); err != nil {
				log.Printf("[ws/noise] write error for %s: %v", c.UserID, err)
				return
			}

		case <-ticker.C:
			if err := c.Conn.SendPing(); err != nil {
				return
			}
		}
	}
}
