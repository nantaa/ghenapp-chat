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
	"github.com/ghenapp/ghenapp/internal/ratelimit"
	"github.com/ghenapp/ghenapp/internal/snowflake"
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
	snowSvc := snowflake.New(cfg.SnowflakeMachineID)
	rateLimiter := ratelimit.New(rdb)
	hub := ws.NewHub()
	router := message.NewRouter(hub, rdb, queries)
	_ = snowSvc // used by message router in Batch 5 full wiring
	_ = router

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

	// Upload routes
	uploadHandler := upload.NewHandler(queries, cfg.UploadPath, 2*1024*1024)
	uploadHandler.RegisterRoutes(v1, authMiddleware)

	// WebSocket
	wsFrameRouter := func(userID string, frame []byte) {
		// Batch 5: full IMCP frame parsing goes here
		log.Printf("[ws] frame from %s: %d bytes", userID, len(frame))
	}
	wsHandler := ws.NewHandler(hub, wsFrameRouter)
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
