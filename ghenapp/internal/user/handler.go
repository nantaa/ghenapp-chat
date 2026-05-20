package user

import (
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"strconv"
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
	rg.POST("/users/me/avatar", authMiddleware, h.UpdateAvatar)
	rg.POST("/prekeys", authMiddleware, h.UploadPrekeys)
	rg.GET("/prekeys/:username", authMiddleware, h.GetPrekeys)
	rg.GET("/conversations", authMiddleware, h.GetConversations)
	rg.GET("/conversations/:id/messages", authMiddleware, h.GetConversationMessages)
	rg.PUT("/conversations/:id/messages/:msg_id/history-blob", authMiddleware, h.UploadHistoryBlob)
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

	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier.String)
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
	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier.String)
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
	h.issueTokenPair(c, user.ID.String(), user.Username, user.Tier.String)
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
		"avatar_url":   user.AvatarUrl,
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
		Discoverable: sql.NullBool{Bool: discoverable, Valid: true},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update failed"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// ─── Update Avatar ────────────────────────────────────────────────────────────

func (h *Handler) UpdateAvatar(c *gin.Context) {
	userID := auth.GetUserID(c)
	uid, err := uuid.Parse(userID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	avatarURL := ""
	var req struct {
		AvatarURL string `json:"avatar_url"`
	}
	if err := c.ShouldBindJSON(&req); err == nil && req.AvatarURL != "" {
		avatarURL = req.AvatarURL
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "avatar_url required"})
		return
	}

	if err := h.queries.UpdateUserAvatar(c.Request.Context(), uid, avatarURL); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update avatar"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"avatar_url": avatarURL})
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

	// IMPORTANT: replace old prekeys so stale/broken rows never survive resets
	if err := h.queries.DeletePrekeysByUser(ctx, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear old prekeys"})
		return
	}

	if err := h.queries.InsertPrekeys(ctx, db.InsertPrekeysParams{
		UserID:  uid,
		KeyType: "signed",
		Column3: [][]byte{req.SignedPrekey},
		Column4: [][]byte{req.Signature},
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store signed prekey"})
		return
	}

	if len(req.OneTimePrekeys) > 0 {
		var sigs [][]byte
		for i := 0; i < len(req.OneTimePrekeys); i++ {
			sigs = append(sigs, nil)
		}
		if err := h.queries.InsertPrekeys(ctx, db.InsertPrekeysParams{
			UserID:  uid,
			KeyType: "onetime",
			Column3: req.OneTimePrekeys,
			Column4: sigs,
		}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store one-time prekeys"})
			return
		}
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
	existing, err := h.queries.GetDirectConversation(ctx, db.GetDirectConversationParams{
		UserID:   uid,
		UserID_2: targetUID,
	})
	if err == nil && existing.ID != uuid.Nil {
		c.JSON(http.StatusOK, gin.H{"conversation_id": existing.ID.String()})
		return
	}

	// No existing DM — create one
	conv, err := h.queries.CreateConversation(ctx, "direct")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create conversation"})
		return
	}
	h.queries.AddConversationMember(ctx, db.AddConversationMemberParams{
		ConversationID: conv.ID,
		UserID:         uid,
	})
	h.queries.AddConversationMember(ctx, db.AddConversationMemberParams{
		ConversationID: conv.ID,
		UserID:         targetUID,
	})

	c.JSON(http.StatusOK, gin.H{"conversation_id": conv.ID.String()})
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

// b64Encode encodes raw bytes to standard base64 string for JSON transport.
func b64Encode(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}

// b64Decode decodes a standard or URL-safe base64 string to raw bytes.
func b64Decode(s string) ([]byte, error) {
	// Try standard first, then URL-safe for tolerance.
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
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
	result := make([]convJSON, 0, len(details))
	for _, d := range details {
		members := make([]memberJSON, 0, len(d.Members))
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

	// Batch-fetch history blobs for the calling user.
	// Build a slice of all message IDs so we can do one DB call.
	msgIDs := make([]int64, len(msgs))
	for i, m := range msgs {
		msgIDs[i] = m.ID
	}
	blobRows, _ := h.queries.GetHistoryBlobsForUser(c.Request.Context(), uid, msgIDs)
	// Index blobs by message ID for O(1) lookup.
	blobMap := make(map[int64][]byte, len(blobRows))
	for _, r := range blobRows {
		blobMap[r.MessageID] = r.Blob
	}

	type msgJSON struct {
		ID             string  `json:"id"`
		ConversationID string  `json:"conversation_id"`
		SenderID       string  `json:"sender_id"`
		Payload        []int   `json:"payload"`
		MsgType        string  `json:"msg_type"`
		TimestampMs    int64   `json:"timestamp_ms"`
		Delivered      bool    `json:"delivered"`
		Read           bool    `json:"read"`
		TtlSeconds     int     `json:"ttl_seconds"`
		HistoryBlob    *string `json:"history_blob"` // base64, nil if not yet uploaded
	}
	result := make([]msgJSON, 0, len(msgs))
	for _, m := range msgs {
		var ttl int
		if m.TtlExpiresAt.Valid {
			ttl = int(m.TtlExpiresAt.Time.Sub(m.Timestamp).Seconds())
		}
		var histBlob *string
		if blob, ok := blobMap[m.ID]; ok && len(blob) > 0 {
			encoded := b64Encode(blob)
			histBlob = &encoded
		}
		result = append(result, msgJSON{
			ID:             strconv.FormatInt(m.ID, 10),
			ConversationID: m.ConversationID.String(),
			SenderID:       m.SenderID.UUID.String(),
			Payload:        b2i(m.Payload),
			MsgType:        m.MsgType,
			TimestampMs:    m.Timestamp.UnixMilli(),
			Delivered:      m.Delivered.Bool,
			Read:           m.ReadAt.Valid,
			TtlSeconds:     ttl,
			HistoryBlob:    histBlob,
		})
	}
	c.JSON(http.StatusOK, gin.H{"messages": result})
}

// ─── Upload History Blob ──────────────────────────────────────────────────────
// PUT /api/v1/conversations/:id/messages/:msg_id/history-blob
// Stores an opaque encrypted blob the caller can use to recover message
// plaintext on a new device. The server never decrypts it.

type uploadHistoryBlobRequest struct {
	Blob string `json:"blob" binding:"required"` // base64-encoded XSalsa20-Poly1305 ciphertext
}

func (h *Handler) UploadHistoryBlob(c *gin.Context) {
	userID := auth.GetUserID(c)
	uid, err := uuid.Parse(userID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	convIDStr := c.Param("id")
	convID, err := uuid.Parse(convIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid conversation id"})
		return
	}

	// Verify caller is a conversation member before storing anything.
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

	msgIDStr := c.Param("msg_id")
	msgID, err := strconv.ParseInt(msgIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid msg_id"})
		return
	}

	var req uploadHistoryBlobRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	blobBytes, err := b64Decode(req.Blob)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "blob must be valid base64"})
		return
	}
	if len(blobBytes) < 25 { // nonce(24) + at least 1 byte ciphertext
		c.JSON(http.StatusBadRequest, gin.H{"error": "blob too short"})
		return
	}
	if len(blobBytes) > 8192 { // sanity cap: no plaintext should be this large
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "blob too large"})
		return
	}

	if err := h.queries.UpsertHistoryBlob(c.Request.Context(), db.UpsertHistoryBlobParams{
		MessageID: msgID,
		UserID:    uid,
		Blob:      blobBytes,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store blob"})
		return
	}

	c.Status(http.StatusNoContent)
}

