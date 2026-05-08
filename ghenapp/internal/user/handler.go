package user

import (
	"crypto/ed25519"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ghenapp/ghenapp/internal/auth"
	"github.com/ghenapp/ghenapp/internal/crypto"
	"github.com/ghenapp/ghenapp/internal/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Handler holds dependencies for user endpoints.
type Handler struct {
	queries *db.Queries
	jwt     *auth.JWTService
	refresh *auth.RefreshService
}

func NewHandler(q *db.Queries, j *auth.JWTService, r *auth.RefreshService) *Handler {
	return &Handler{queries: q, jwt: j, refresh: r}
}

// RegisterRoutes wires user routes onto the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup, authMiddleware gin.HandlerFunc) {
	rg.POST("/register", h.Register)
	rg.POST("/login", h.Login)
	rg.POST("/refresh", h.Refresh)
	rg.POST("/logout", authMiddleware, h.Logout)
	rg.GET("/users/:username", h.GetUser)
	rg.PUT("/users/me", authMiddleware, h.UpdateProfile)
	rg.POST("/prekeys", authMiddleware, h.UploadPrekeys)
	rg.GET("/prekeys/:username", authMiddleware, h.GetPrekeys)
	rg.GET("/conversations", authMiddleware, h.GetConversations)
	rg.GET("/conversations/:id/messages", authMiddleware, h.GetConversationMessages)
}

// ─── Register ────────────────────────────────────────────────────────────────

type registerRequest struct {
	Username  string `json:"username" binding:"required,min=3,max=32,alphanum"`
	PublicKey []byte `json:"public_key" binding:"required"` // Ed25519 raw 32-byte key
}

func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.PublicKey) != ed25519.PublicKeySize {
		c.JSON(http.StatusBadRequest, gin.H{"error": "public_key must be 32 bytes (Ed25519)"})
		return
	}

	user, err := h.queries.CreateUser(c.Request.Context(), db.CreateUserParams{
		Username:  strings.ToLower(req.Username),
		PublicKey: req.PublicKey,
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "username already taken"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}

	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier)
}

// ─── Login ───────────────────────────────────────────────────────────────────

type loginRequest struct {
	Username  string `json:"username" binding:"required"`
	Challenge []byte `json:"challenge"`                    // server-issued challenge bytes (future)
	Signature []byte `json:"signature" binding:"required"` // Ed25519 signature over challenge
}

// Login verifies an Ed25519 signature over a fixed auth challenge.
// v1 simplified: client signs the UTF-8 string "ghenapp-login:{username}:{unix_minute}"
// This prevents replay across minutes without a stateful challenge round-trip.
func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := h.queries.GetUserByUsername(c.Request.Context(), strings.ToLower(req.Username))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	// Build expected challenge messages: accept current minute AND previous minute
	// to handle clock skew and users who sign right at a minute boundary.
	now := time.Now().UTC()
	minute := now.Truncate(time.Minute).Unix()
	prevMinute := now.Add(-time.Minute).Truncate(time.Minute).Unix()

	msgCurrent := []byte(fmt.Sprintf("ghenapp-login:%s:%d", user.Username, minute))
	msgPrev := []byte(fmt.Sprintf("ghenapp-login:%s:%d", user.Username, prevMinute))
	pubKey := ed25519.PublicKey(user.PublicKey)

	if !ed25519.Verify(pubKey, msgCurrent, req.Signature) && !ed25519.Verify(pubKey, msgPrev, req.Signature) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return
	}

	_ = h.queries.UpdateLastSeen(c.Request.Context(), user.ID)
	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier)
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

type refreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

func (h *Handler) Refresh(c *gin.Context) {
	var req refreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	userID, err := h.refresh.Validate(c.Request.Context(), req.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired refresh token"})
		return
	}
	user, err := h.queries.GetUserByID(c.Request.Context(), mustParseUUID(userID))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
		return
	}
	// Rotate: revoke old, issue new pair
	_ = h.refresh.Revoke(c.Request.Context(), req.RefreshToken)
	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier)
}

// ─── Logout ──────────────────────────────────────────────────────────────────

type logoutRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

func (h *Handler) Logout(c *gin.Context) {
	var req logoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_ = h.refresh.Revoke(c.Request.Context(), req.RefreshToken)
	c.JSON(http.StatusOK, gin.H{"message": "logged out"})
}

// ─── Get User ─────────────────────────────────────────────────────────────────

func (h *Handler) GetUser(c *gin.Context) {
	username := strings.ToLower(c.Param("username"))
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":           user.ID,
		"username":     user.Username,
		"display_name": user.DisplayName,
		"public_key":   b2i(user.PublicKey),
		"key_version":  user.KeyVersion,
		"discoverable": user.Discoverable,
	})
}

// ─── Update Profile ───────────────────────────────────────────────────────────

type updateProfileRequest struct {
	DisplayName  string `json:"display_name"`
	Discoverable *bool  `json:"discoverable"`
}

func (h *Handler) UpdateProfile(c *gin.Context) {
	userID := auth.GetUserID(c)
	var req updateProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	discoverable := true
	if req.Discoverable != nil {
		discoverable = *req.Discoverable
	}
	uid, err := uuid.Parse(userID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	user, err := h.queries.UpdateUserProfile(c.Request.Context(), db.UpdateUserProfileParams{
		ID:           uid,
		DisplayName:  sql.NullString{String: req.DisplayName, Valid: req.DisplayName != ""},
		Discoverable: discoverable,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update failed"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// ─── Prekeys ──────────────────────────────────────────────────────────────────

type uploadPrekeysRequest struct {
	SignedPrekey   []byte   `json:"signed_prekey" binding:"required"`
	Signature      []byte   `json:"signature" binding:"required"`
	OneTimePrekeys [][]byte `json:"onetime_prekeys"`
}

func valid32(b []byte) bool { return len(b) == 32 }
func valid64(b []byte) bool { return len(b) == 64 }

func (h *Handler) UploadPrekeys(c *gin.Context) {
	userID := auth.GetUserID(c)
	var req uploadPrekeysRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !valid32(req.SignedPrekey) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "signed prekey must be 32 bytes"})
		return
	}
	if !valid64(req.Signature) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "signed prekey signature must be 64 bytes"})
		return
	}
	for i, otpk := range req.OneTimePrekeys {
		if !valid32(otpk) {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("onetime_prekeys[%d] must be 32 bytes", i)})
			return
		}
	}

	ctx := c.Request.Context()
	uid, err := uuid.Parse(userID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	user, err := h.queries.GetUserByID(ctx, uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "user not found"})
		return
	}
	if len(user.PublicKey) != 32 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "stored identity public key invalid"})
		return
	}
	if err := crypto.VerifySignedPrekey(user.PublicKey, req.SignedPrekey, req.Signature); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "signed prekey signature invalid"})
		return
	}

	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start transaction"})
		return
	}
	defer tx.Rollback()

	qtx := h.queries.WithTx(tx)

	// IMPORTANT: replace old prekeys so stale/broken rows never survive resets
	if err := qtx.DeletePrekeysByUser(ctx, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear old prekeys"})
		return
	}

	if err := qtx.InsertSignedPrekey(ctx, db.InsertSignedPrekeyParams{
		UserID:    uid,
		PublicKey: req.SignedPrekey,
		Signature: req.Signature,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store signed prekey"})
		return
	}

	for _, otpk := range req.OneTimePrekeys {
		if err := qtx.InsertOneTimePrekey(ctx, db.InsertOneTimePrekeyParams{
			UserID:    uid,
			PublicKey: otpk,
		}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store one-time prekeys"})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to commit prekeys"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":       "prekeys uploaded",
		"onetime_count": len(req.OneTimePrekeys),
	})
}

// ─── Direct Messages ─────────────────────────────────────────────────────────

type createDMRequest struct {
	TargetUserID string `json:"target_user_id" binding:"required,uuid"`
}

func (h *Handler) CreateDM(c *gin.Context) {
	var req createDMRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	userID := auth.GetUserID(c)
	uid, _ := uuid.Parse(userID)
	targetUID, _ := uuid.Parse(req.TargetUserID)

	if uid == targetUID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot create dm with yourself"})
		return
	}

	ctx := c.Request.Context()

	// Check if a DM conversation already exists between these two users
	existing, err := h.queries.FindExistingDM(ctx, uid, targetUID)
	if err == nil && existing != uuid.Nil {
		c.JSON(http.StatusOK, gin.H{"conversation_id": existing.String()})
		return
	}

	// No existing DM — create one
	convID, err := h.queries.CreateConversation(ctx, "direct")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create conversation"})
		return
	}
	h.queries.AddConversationMember(ctx, convID, uid)
	h.queries.AddConversationMember(ctx, convID, targetUID)

	c.JSON(http.StatusOK, gin.H{"conversation_id": convID.String()})
}

func (h *Handler) GetPrekeys(c *gin.Context) {
	username := strings.ToLower(c.Param("username"))
	ctx := c.Request.Context()

	target, err := h.queries.GetUserByUsername(ctx, username)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if len(target.PublicKey) != 32 {
		c.JSON(http.StatusConflict, gin.H{"error": "user identity key invalid"})
		return
	}

	signed, err := h.queries.GetSignedPrekey(ctx, target.ID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no signed prekey available"})
		return
	}
	if len(signed.PublicKey) != 32 || len(signed.Signature) != 64 {
		c.JSON(http.StatusConflict, gin.H{"error": "signed prekey invalid; user must refresh prekeys"})
		return
	}

	otpk, _ := h.queries.GetAvailablePrekey(ctx, db.GetAvailablePrekeyParams{
		UserID:  target.ID,
		KeyType: "onetime",
	})
	if otpk.ID != uuid.Nil {
		if len(otpk.PublicKey) != 32 {
			c.JSON(http.StatusConflict, gin.H{"error": "one-time prekey invalid; user must refresh prekeys"})
			return
		}
		_ = h.queries.MarkPrekeyUsed(ctx, otpk.ID)
	}

	c.JSON(http.StatusOK, gin.H{
		"user_id":     target.ID,
		"username":    target.Username,
		"public_key":  b2i(target.PublicKey),
		"key_version": target.KeyVersion,
		"signed_prekey": gin.H{
			"public_key": b2i(signed.PublicKey),
			"signature":  b2i(signed.Signature),
		},
		"onetime_prekey": func() any {
			if otpk.ID != uuid.Nil {
				return gin.H{"public_key": b2i(otpk.PublicKey)}
			}
			return nil
		}(),
	})
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func (h *Handler) issueTokenPair(c *gin.Context, userID, username, tier string) {
	accessToken, err := h.jwt.Issue(userID, username, tier)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token generation failed"})
		return
	}
	refreshToken, err := h.refresh.Issue(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "refresh token generation failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"token_type":    "Bearer",
	})
}

func mustParseUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

// b2i converts a []byte to []int so JSON serializes as a number array
// instead of a base64 string. Frontend uses new Uint8Array(arr) to reconstruct.
func b2i(b []byte) []int {
	out := make([]int, len(b))
	for i, v := range b {
		out[i] = int(v)
	}
	return out
}

func (h *Handler) GetConversations(c *gin.Context) {
	userID := auth.GetUserID(c)
	uid, err := uuid.Parse(userID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	details, err := h.queries.GetUserConversationsWithDetails(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch conversations"})
		return
	}
	type memberJSON struct {
		UserID   string `json:"user_id"`
		Username string `json:"username"`
	}
	type convJSON struct {
		ID      string       `json:"id"`
		Type    string       `json:"type"`
		Members []memberJSON `json:"members"`
	}
	var result []convJSON
	for _, d := range details {
		var members []memberJSON
		for _, uid := range d.Members {
			members = append(members, memberJSON{
				UserID:   uid.String(),
				Username: d.MemberUsernames[uid],
			})
		}
		result = append(result, convJSON{
			ID:      d.ID.String(),
			Type:    d.Type,
			Members: members,
		})
	}
	c.JSON(http.StatusOK, gin.H{"conversations": result})
}

func (h *Handler) GetConversationMessages(c *gin.Context) {
	convIDStr := c.Param("id")
	convID, err := uuid.Parse(convIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid conversation id"})
		return
	}
	// Verify caller is a member
	userID := auth.GetUserID(c)
	uid, _ := uuid.Parse(userID)
	members, _ := h.queries.GetConversationMembers(c.Request.Context(), convID)
	isMember := false
	for _, m := range members {
		if m == uid {
			isMember = true
			break
		}
	}
	if !isMember {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member"})
		return
	}
	msgs, err := h.queries.GetConversationMessages(c.Request.Context(), convID, 50)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch messages"})
		return
	}
	type msgJSON struct {
		ID             int64  `json:"id"`
		ConversationID string `json:"conversation_id"`
		SenderID       string `json:"sender_id"`
		Payload        []int  `json:"payload"`
		MsgType        string `json:"msg_type"`
		TimestampMs    int64  `json:"timestamp_ms"`
		Delivered      bool   `json:"delivered"`
	}
	var result []msgJSON
	for _, m := range msgs {
		result = append(result, msgJSON{
			ID:             m.ID,
			ConversationID: m.ConversationID.String(),
			SenderID:       m.SenderID.String(),
			Payload:        b2i(m.Payload),
			MsgType:        m.MsgType,
			TimestampMs:    m.Timestamp,
			Delivered:      m.Delivered,
		})
	}
	c.JSON(http.StatusOK, gin.H{"messages": result})
}
