package push

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Handler exposes the VAPID key and subscription management REST API.
type Handler struct {
	svc *Service
}

// NewHandler creates a push HTTP handler.
func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// RegisterRoutes mounts the push notification routes on the given router group.
//
//	GET    /push/vapid-key     — returns the server VAPID public key (no auth required)
//	POST   /push/subscribe     — save/update a push subscription     (auth required)
//	DELETE /push/subscribe     — remove a push subscription          (auth required)
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup, authMiddleware gin.HandlerFunc) {
	// VAPID public key is public — browsers need this before they can subscribe
	rg.GET("/push/vapid-key", h.getVAPIDKey)

	auth := rg.Group("", authMiddleware)
	auth.POST("/push/subscribe", h.subscribe)
	auth.DELETE("/push/subscribe", h.unsubscribe)
}

// GET /api/v1/push/vapid-key
func (h *Handler) getVAPIDKey(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"public_key": h.svc.PublicKey(),
	})
}

// POST /api/v1/push/subscribe
// Body: { "endpoint": "…", "keys": { "p256dh": "…", "auth": "…" } }
func (h *Handler) subscribe(c *gin.Context) {
	userIDStr, _ := c.Get("userID")
	uid, err := uuid.Parse(userIDStr.(string))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	var sub Subscription
	if err := c.ShouldBindJSON(&sub); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid subscription"})
		return
	}
	if sub.Endpoint == "" || sub.Keys.P256DH == "" || sub.Keys.Auth == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "endpoint, keys.p256dh and keys.auth are required"})
		return
	}

	ua := c.GetHeader("User-Agent")
	if err := h.svc.SaveSubscription(c.Request.Context(), uid, sub, ua); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save subscription"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "subscribed"})
}

// DELETE /api/v1/push/subscribe
// Body: { "endpoint": "…" }
func (h *Handler) unsubscribe(c *gin.Context) {
	userIDStr, _ := c.Get("userID")
	uid, err := uuid.Parse(userIDStr.(string))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Endpoint == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "endpoint required"})
		return
	}

	if err := h.svc.DeleteSubscription(c.Request.Context(), uid, req.Endpoint); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove subscription"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "unsubscribed"})
}
