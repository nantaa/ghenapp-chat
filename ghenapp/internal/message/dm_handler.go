package message

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/ghenapp/ghenapp/internal/db"
)

type DMHandler struct {
	queries *db.Queries
}

func NewDMHandler(q *db.Queries) *DMHandler {
	return &DMHandler{queries: q}
}

type createDMRequest struct {
	TargetUserID string `json:"target_user_id" binding:"required"`
}

func (h *DMHandler) CreateDM(c *gin.Context) {
	callerID := c.GetString("userID")
	if callerID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req createDMRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	targetID, err := uuid.Parse(req.TargetUserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid target_user_id"})
		return
	}

	callerUUID, err := uuid.Parse(callerID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid caller id"})
		return
	}

	ctx := c.Request.Context()

	conv, err := h.queries.CreateConversation(ctx, "dm")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create conversation: " + err.Error()})
		return
	}

	if err := h.queries.AddConversationMember(ctx, db.AddConversationMemberParams{
		ConversationID: conv.ID,
		UserID:         callerUUID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "add caller member: " + err.Error()})
		return
	}

	if err := h.queries.AddConversationMember(ctx, db.AddConversationMemberParams{
		ConversationID: conv.ID,
		UserID:         targetID,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "add target member: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"conversation_id": conv.ID.String()})
}

func (h *DMHandler) GetE2ESession(c *gin.Context) {
	convIDStr := c.Param("conversation_id")
	if convIDStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing conversation_id"})
		return
	}

	ctx := c.Request.Context()
	sess, err := h.queries.GetE2ESessionByConvIDStr(ctx, convIDStr)
	if err != nil {
		if db.IsE2ESessionNoRows(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no session found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"conversation_id": sess.ConversationID.String(),
		"sender_id":       sess.SenderID.String(),
		"sender_ik_pub":   sess.SenderIKPub, // gin will base64-encode byte slices
		"sender_ek_pub":   sess.SenderEKPub,
		"opk_pub":         sess.OPKPub,
	})
}
