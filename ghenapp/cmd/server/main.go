package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"

	"github.com/ghenapp/ghenapp/config"
	"github.com/ghenapp/ghenapp/internal/auth"
	"github.com/ghenapp/ghenapp/internal/db"
	"github.com/ghenapp/ghenapp/internal/group"
	"github.com/ghenapp/ghenapp/internal/message"
	"github.com/ghenapp/ghenapp/internal/push"
	"github.com/ghenapp/ghenapp/internal/ratelimit"

	"github.com/ghenapp/ghenapp/internal/upload"
	"github.com/ghenapp/ghenapp/internal/user"
	"github.com/ghenapp/ghenapp/internal/ws"
)

func main() {
	// ─── Config ──────────────────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// ─── Database ────────────────────────────────────────────────────────────
	sqlDB, err := sql.Open("postgres", cfg.DSN())
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)
	if err := sqlDB.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}
	log.Println("[main] PostgreSQL connected")

	// ─── Redis ───────────────────────────────────────────────────────────────
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("redis ping: %v", err)
	}
	log.Println("[main] Redis connected")

	// ─── Services ────────────────────────────────────────────────────────────
	queries := db.New(sqlDB)
	jwtSvc := auth.NewJWTService(cfg.JWTSecret, cfg.JWTExpiry)
	refreshSvc := auth.NewRefreshService(rdb, cfg.RefreshTokenExpiry)
	rateLimiter := ratelimit.New(rdb)
	hub := ws.NewHub()
	router := message.NewRouter(hub, rdb, queries)

	// ─── Noise_XX Server Key ──────────────────────────────────────────────────
	noiseKP, err := ws.GenerateNoiseKeyPair()
	if err != nil {
		log.Fatalf("noise keygen: %v", err)
	}
	log.Printf("[noise] server static pubkey: %x", noiseKP.Public[:8])

	// ─── Background Jobs ────────────────────────────────────────────────────────────
	// TTL: purge expired messages every 5 minutes
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			if err := queries.DeleteExpiredMessages(context.Background()); err != nil {
				log.Printf("[ttl] purge error: %v", err)
			}
		}
	}()

	// ─── VAPID / Web Push ─────────────────────────────────────────────────────────
	vapidPath := "vapid_keys.json"
	vapidKeys, err := push.LoadOrGenerateVAPIDKeys(vapidPath)
	if err != nil {
		log.Fatalf("vapid keys: %v", err)
	}
	vapidSubject := os.Getenv("VAPID_SUBJECT")
	if vapidSubject == "" {
		vapidSubject = "mailto:admin@ghenapp.local"
	}
	pushSvc := push.New(sqlDB, vapidKeys, vapidSubject)
	router.SetPushService(pushSvc)

	// ─── Gin ─────────────────────────────────────────────────────────────────
	if !cfg.IsDevelopment() {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())

	// ─── Routes ──────────────────────────────────────────────────────────────
	r.GET("/health", healthHandler(cfg))

	authMiddleware := auth.Middleware(jwtSvc)
	apiMiddleware := ratelimit.APIMiddleware(rateLimiter)

	v1 := r.Group("/api/v1", apiMiddleware)

	// User routes
	userHandler := user.NewHandler(queries, jwtSvc, refreshSvc)
	userHandler.RegisterRoutes(v1, authMiddleware)

	// Group routes
	groupHandler := group.NewHandler(queries)
	groupHandler.RegisterRoutes(v1, authMiddleware)

	// Push notification routes
	pushHandler := push.NewHandler(pushSvc)
	pushHandler.RegisterRoutes(v1, authMiddleware)

	// Upload routes
	uploadHandler := upload.NewHandler(queries, cfg.UploadPath, 2*1024*1024)
	uploadHandler.RegisterRoutes(v1, authMiddleware)


	// DM routes
	dmHandler := message.NewDMHandler(queries)
	v1.POST("/dm", authMiddleware, dmHandler.CreateDM)

	// WebSocket — with real IMCP frame routing
	wsFrameRouter := func(userID string, rawFrame []byte) {
		// Parse IMCP binary frame
		frame, err := ws.Decode(rawFrame)
		if err != nil {
			log.Printf("[ws] invalid frame from %s: %v", userID, err)
			return
		}

		log.Printf("[ws] frame from %s: id=%d payloadLen=%d rawFrameLen=%d", userID, frame.ID, len(frame.Payload), len(rawFrame))

		// Build envelope — server never inspects payload (passthrough)
		env := &message.Envelope{
			ID:             int64(frame.ID), // Use client's generated ID
			ConversationID: ws.ConversationIDToString(frame.ConversationID),
			SenderID:       userID,
			Payload:        frame.Payload,
			MsgType:        frame.Type.String(),
			Timestamp:      frame.TimestampMS,
			TTLSeconds:     frame.TTLSeconds,
		}

		// Persist ONCE — upsert so reconnect re-sends overwrite any stale empty-payload row
		if err := router.StoreOffline(context.Background(), env); err != nil {
			log.Printf("[ws] db store error for id=%d payloadLen=%d: %v", frame.ID, len(frame.Payload), err)
		} else {
			log.Printf("[ws] stored id=%d payloadLen=%d", frame.ID, len(frame.Payload))
		}

		// Fetch all members of this conversation and route to each recipient
		convID, err := ws.ConversationIDFromBytes(frame.ConversationID)
		if err == nil {
			members, _ := queries.GetConversationMembers(context.Background(), convID)
			for _, m := range members {
				_ = router.Deliver(context.Background(), m.String(), env, rawFrame)
			}
		}
	}
	wsHandler := ws.NewHandler(hub, wsFrameRouter)
	wsHandler.SetOnConnect(router.SubscribeAndForward)
	// Enable Noise_XX transport encryption — clients must complete handshake
	// before sending IMCP frames. Set NOISE_DISABLED=1 to skip for integration tests.
	if os.Getenv("NOISE_DISABLED") != "1" {
		wsHandler.EnableNoise(noiseKP)
	}

	// /api/v1/noise/pubkey — clients fetch this to initiate XX handshake
	v1.GET("/noise/pubkey", func(c *gin.Context) {
		pub := wsHandler.ServerPublicKey()
		if pub == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Noise not enabled"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"public_key": pub})
	})

	r.GET("/ws", func(c *gin.Context) {
		// Auth via query param for WebSocket (browsers can't set custom headers)
		tokenStr := c.Query("token")
		if tokenStr == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims, err := jwtSvc.Parse(tokenStr)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		c.Set("userID", claims.UserID)
		c.Set("username", claims.Username)
		c.Set("tier", claims.Tier)
		wsHandler.ServeWS(c)
	})

	// ─── Uploads dir ─────────────────────────────────────────────────────────
	if err := os.MkdirAll(cfg.UploadPath, 0755); err != nil {
		log.Fatalf("uploads dir: %v", err)
	}

	// ─── HTTP Server ─────────────────────────────────────────────────────────
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("[GhenApp] REST API  → http://localhost:%s", cfg.Port)
		log.Printf("[GhenApp] WebSocket → ws://localhost:%s/ws", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	// ─── Graceful Shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("[GhenApp] Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Println("[GhenApp] Stopped.")
}

func healthHandler(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"app":     "GhenApp",
			"version": "0.1.0",
			"env":     cfg.AppEnv,
			"time":    fmt.Sprintf("%d", time.Now().UnixMilli()),
		})
	}
}
