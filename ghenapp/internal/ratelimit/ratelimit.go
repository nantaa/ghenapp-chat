package ratelimit

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// Limits defines rate limit thresholds for a tier.
type Limits struct {
	MessagesPerMin    int
	UploadsPerHour    int
	ConnectionsPerMin int
	APICallsPerMin    int
}

var FreeLimits = Limits{
	MessagesPerMin:    60,
	UploadsPerHour:    20,
	ConnectionsPerMin: 5,
	APICallsPerMin:    100,
}

var PremiumLimits = Limits{
	MessagesPerMin:    300,
	UploadsPerHour:    100,
	ConnectionsPerMin: 20,
	APICallsPerMin:    500,
}

// Limiter is a Redis sliding-window rate limiter keyed per user identity.
type Limiter struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Limiter {
	return &Limiter{rdb: rdb}
}

// Allow checks if the action is within limit for the given user+action key.
// Returns true if allowed. Uses a simple fixed-window counter in Redis.
func (l *Limiter) Allow(ctx context.Context, userID, action string, limit int, window time.Duration) (bool, error) {
	key := fmt.Sprintf("rl:%s:%s", action, userID)
	pipe := l.rdb.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, window)
	if _, err := pipe.Exec(ctx); err != nil {
		// Fail open — if Redis is down, allow the request
		return true, err
	}
	return incr.Val() <= int64(limit), nil
}

// APIMiddleware applies per-user API rate limiting using the user's tier.
func APIMiddleware(limiter *Limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID, _ := c.Get("userID")
		tier, _ := c.Get("tier")

		uid, _ := userID.(string)
		if uid == "" {
			c.Next()
			return
		}

		limits := FreeLimits
		if tier == "premium" {
			limits = PremiumLimits
		}

		allowed, _ := limiter.Allow(c.Request.Context(), uid, "api", limits.APICallsPerMin, time.Minute)
		if !allowed {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "rate limit exceeded",
				"code":  "RATE_LIMITED",
			})
			return
		}
		c.Next()
	}
}
