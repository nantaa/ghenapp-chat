package group

import (
	"database/sql"
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

// RegisterRoutes wires group routes.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup, authMiddleware gin.HandlerFunc) {
	rg.POST("/groups", authMiddleware, h.CreateGroup)
	rg.POST("/groups/:id/members", authMiddleware, h.AddMember)
}

type createGroupRequest struct {
	Name string `json:"name" binding:"required"`
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

	// 1. Create a group conversation
	convID, err := h.queries.CreateConversation(ctx, "group")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create conversation"})
		return
	}

	// 2. Create the group record
	// NOTE: Requires a method in db.Queries for groups, we'll use raw SQL for now
	// until sqlc runs.
	var groupID uuid.UUID
	err = h.queries.DB().QueryRowContext(ctx,
		`INSERT INTO groups (conversation_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
		convID, req.Name, uid,
	).Scan(&groupID)

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group"})
		return
	}

	// 3. Add creator as admin member
	_, err = h.queries.DB().ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
		groupID, uid,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add member"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":              groupID,
		"conversation_id": convID,
		"name":            req.Name,
		"created_at":      time.Now(),
	})
}

type addMemberRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

func (h *Handler) AddMember(c *gin.Context) {
	groupIDStr := c.Param("id")
	groupID, err := uuid.Parse(groupIDStr)
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
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid target user id"})
		return
	}

	ctx := c.Request.Context()

	// In a real app, verify caller is an admin of the group.
	// For prototype, we just add the member.
	_, err = h.queries.DB().ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
		groupID, targetID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add member"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "member added"})
}

// Add DB method accessor for raw queries in prototype
func (q *db.Queries) DB() *sql.DB {
	return q.db // Error here because q.db is unexported. I'll add an exported DB() method to queries.go
}
