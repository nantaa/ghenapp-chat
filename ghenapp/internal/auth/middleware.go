package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const userIDKey = "userID"
const usernameKey = "username"
const tierKey = "tier"

// Middleware returns a Gin handler that validates the JWT Bearer token.
// On success it injects userID, username, tier into the context.
func Middleware(jwt *JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing authorization header"})
			return
		}
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid authorization format"})
			return
		}
		claims, err := jwt.Parse(parts[1])
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		c.Set(userIDKey, claims.UserID)
		c.Set(usernameKey, claims.Username)
		c.Set(tierKey, claims.Tier)
		c.Next()
	}
}

// GetUserID extracts the authenticated user ID from the Gin context.
func GetUserID(c *gin.Context) string {
	v, _ := c.Get(userIDKey)
	s, _ := v.(string)
	return s
}

// GetTier extracts the tier ("free"|"premium") from the Gin context.
func GetTier(c *gin.Context) string {
	v, _ := c.Get(tierKey)
	s, _ := v.(string)
	return s
}
