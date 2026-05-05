package group

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/ghenapp/ghenapp/internal/auth"
	"github.com/ghenapp/ghenapp/internal/db"
)

// Handler manages group creation and membership.
type Handler struct {
	queries *db.Queries
}

func NewHandler(q *db.Queries) *Handler {
	return &Handler{queries: q}
}

// RegisterRoutes wires all group routes.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup, authMiddleware gin.HandlerFunc) {
	rg.POST("/groups", authMiddleware, h.CreateGroup)
	rg.GET("/groups/:id", authMiddleware, h.GetGroup)
	rg.POST("/groups/:id/members", authMiddleware, h.AddMember)
	rg.DELETE("/groups/:id/members/:uid", authMiddleware, h.RemoveMember)
	rg.POST("/groups/:id/invite", authMiddleware, h.CreateInvite)
	rg.POST("/invite/:token/join", authMiddleware, h.JoinViaInvite)
	rg.DELETE("/groups/:id/invite/:token", authMiddleware, h.RevokeInvite)
	// Sender Keys
	rg.POST("/groups/:id/sender-key", authMiddleware, h.UploadSenderKey)
	rg.GET("/groups/:id/sender-keys", authMiddleware, h.GetSenderKeys)
}

// ─── Create Group ─────────────────────────────────────────────────────────────

type createGroupRequest struct {
	Name string `json:"name" binding:"required,min=1,max=100"`
}

func (h *Handler) CreateGroup(c *gin.Context) {
	userID := auth.GetUserID(c)
	var req createGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	uid, _ := uuid.Parse(userID)
	ctx := c.Request.Context()
	sqlDB := h.queries.DB()

	convID, err := h.queries.CreateConversation(ctx, "group")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create conversation"})
		return
	}

	var groupID uuid.UUID
	err = sqlDB.QueryRowContext(ctx,
		`INSERT INTO groups (conversation_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
		convID, req.Name, uid,
	).Scan(&groupID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group"})
		return
	}

	_, err = sqlDB.ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
		groupID, uid,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add creator as admin"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":              groupID,
		"conversation_id": convID,
		"name":            req.Name,
		"created_at":      time.Now(),
	})
}

// ─── Get Group ────────────────────────────────────────────────────────────────

func (h *Handler) GetGroup(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}

	ctx := c.Request.Context()
	sqlDB := h.queries.DB()

	type GroupRow struct {
		ID             uuid.UUID `json:"id"`
		ConversationID uuid.UUID `json:"conversation_id"`
		Name           string    `json:"name"`
		CreatedBy      uuid.UUID `json:"created_by"`
		CreatedAt      time.Time `json:"created_at"`
	}
	var g GroupRow
	err = sqlDB.QueryRowContext(ctx,
		`SELECT id, conversation_id, name, created_by, created_at FROM groups WHERE id=$1`,
		groupID,
	).Scan(&g.ID, &g.ConversationID, &g.Name, &g.CreatedBy, &g.CreatedAt)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
		return
	}

	type MemberRow struct {
		UserID uuid.UUID `json:"user_id"`
		Role   string    `json:"role"`
	}
	rows, _ := sqlDB.QueryContext(ctx,
		`SELECT user_id, role FROM group_members WHERE group_id=$1`,
		groupID,
	)
	var members []MemberRow
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var m MemberRow
			if rows.Scan(&m.UserID, &m.Role) == nil {
				members = append(members, m)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"group": g, "members": members})
}

// ─── Add Member ───────────────────────────────────────────────────────────────

type addMemberRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

func (h *Handler) AddMember(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	var req addMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	callerID := auth.GetUserID(c)
	if err := h.assertAdmin(c, groupID, callerID); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can add members"})
		return
	}

	_, err = h.queries.DB().ExecContext(c.Request.Context(),
		`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
		groupID, targetID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add member"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "member added"})
}

// ─── Remove Member ────────────────────────────────────────────────────────────

func (h *Handler) RemoveMember(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	targetID, err := uuid.Parse(c.Param("uid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	callerID := auth.GetUserID(c)
	if err := h.assertAdmin(c, groupID, callerID); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can remove members"})
		return
	}

	_, err = h.queries.DB().ExecContext(c.Request.Context(),
		`DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`,
		groupID, targetID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove member"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "member removed"})
}

// ─── Invite Links ─────────────────────────────────────────────────────────────

type createInviteRequest struct {
	ExpiresInHours int `json:"expires_in_hours" binding:"required,min=1,max=720"`
	MaxUses        int `json:"max_uses" binding:"required,min=1,max=1000"`
}

func (h *Handler) CreateInvite(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	callerID := auth.GetUserID(c)
	if err := h.assertAdmin(c, groupID, callerID); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can create invites"})
		return
	}

	var req createInviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	token := uuid.New().String()
	expiresAt := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
	uid, _ := uuid.Parse(callerID)

	_, err = h.queries.DB().ExecContext(c.Request.Context(),
		`INSERT INTO invite_links (token, group_id, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4, $5)`,
		token, groupID, uid, expiresAt, req.MaxUses,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create invite"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "expires_at": expiresAt, "max_uses": req.MaxUses})
}

func (h *Handler) JoinViaInvite(c *gin.Context) {
	token := c.Param("token")
	callerID := auth.GetUserID(c)
	uid, _ := uuid.Parse(callerID)
	ctx := c.Request.Context()
	sqlDB := h.queries.DB()

	var groupID uuid.UUID
	var expiresAt time.Time
	var maxUses, useCount int
	var revoked bool
	err := sqlDB.QueryRowContext(ctx,
		`SELECT group_id, expires_at, max_uses, use_count, revoked FROM invite_links WHERE token=$1`,
		token,
	).Scan(&groupID, &expiresAt, &maxUses, &useCount, &revoked)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "invite not found"})
		return
	}
	if revoked {
		c.JSON(http.StatusGone, gin.H{"error": "invite has been revoked"})
		return
	}
	if time.Now().After(expiresAt) {
		c.JSON(http.StatusGone, gin.H{"error": "invite has expired"})
		return
	}
	if useCount >= maxUses {
		c.JSON(http.StatusGone, gin.H{"error": "invite has reached max uses"})
		return
	}

	_, err = sqlDB.ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
		groupID, uid,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to join group"})
		return
	}

	_, _ = sqlDB.ExecContext(ctx,
		`UPDATE invite_links SET use_count=use_count+1 WHERE token=$1`, token,
	)

	c.JSON(http.StatusOK, gin.H{"message": "joined group", "group_id": groupID})
}

func (h *Handler) RevokeInvite(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	token := c.Param("token")
	callerID := auth.GetUserID(c)
	if err := h.assertAdmin(c, groupID, callerID); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can revoke invites"})
		return
	}

	_, err = h.queries.DB().ExecContext(c.Request.Context(),
		`UPDATE invite_links SET revoked=TRUE WHERE token=$1 AND group_id=$2`,
		token, groupID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to revoke invite"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "invite revoked"})
}

// ─── Sender Keys ──────────────────────────────────────────────────────────────

type uploadSenderKeyRequest struct {
	// Map of user_id → encrypted sender key blob for that member
	EncryptedKeys map[string][]byte `json:"encrypted_keys" binding:"required"`
}

func (h *Handler) UploadSenderKey(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	senderID := auth.GetUserID(c)
	var req uploadSenderKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	sqlDB := h.queries.DB()
	uid, _ := uuid.Parse(senderID)

	// Upsert a sender_key row per (group, sender, recipient)
	for recipientStr, keyBlob := range req.EncryptedKeys {
		recipientID, err := uuid.Parse(recipientStr)
		if err != nil {
			continue
		}
		_, _ = sqlDB.ExecContext(ctx,
			`INSERT INTO sender_keys (group_id, sender_id, recipient_id, key_blob)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (group_id, sender_id, recipient_id)
			 DO UPDATE SET key_blob=EXCLUDED.key_blob, updated_at=NOW()`,
			groupID, uid, recipientID, keyBlob,
		)
	}
	c.JSON(http.StatusOK, gin.H{"message": "sender keys uploaded"})
}

func (h *Handler) GetSenderKeys(c *gin.Context) {
	groupID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group id"})
		return
	}
	callerID := auth.GetUserID(c)
	uid, _ := uuid.Parse(callerID)
	ctx := c.Request.Context()

	rows, err := h.queries.DB().QueryContext(ctx,
		`SELECT sender_id, key_blob FROM sender_keys WHERE group_id=$1 AND recipient_id=$2`,
		groupID, uid,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch sender keys"})
		return
	}
	defer rows.Close()

	keys := map[string][]byte{}
	for rows.Next() {
		var senderID uuid.UUID
		var blob []byte
		if rows.Scan(&senderID, &blob) == nil {
			keys[senderID.String()] = blob
		}
	}
	c.JSON(http.StatusOK, gin.H{"sender_keys": keys})
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func (h *Handler) assertAdmin(c *gin.Context, groupID uuid.UUID, callerID string) error {
	uid, _ := uuid.Parse(callerID)
	var role string
	err := h.queries.DB().QueryRowContext(c.Request.Context(),
		`SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2`,
		groupID, uid,
	).Scan(&role)
	if err != nil || role != "admin" {
		return err
	}
	return nil
}
