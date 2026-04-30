package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

// Config holds all application configuration loaded from environment variables.
type Config struct {
	// App
	AppEnv string
	Port   string
	WSPort string

	// JWT
	JWTSecret            string
	JWTExpiry            time.Duration
	RefreshTokenExpiry   time.Duration

	// Database
	DBHost     string
	DBPort     string
	DBName     string
	DBUser     string
	DBPassword string
	DBSSLMode  string

	// Redis
	RedisAddr     string
	RedisPassword string
	RedisDB       int

	// File storage
	UploadPath     string
	MaxUploadBytes int64

	// Web Push (deferred — populated later)
	VAPIDPublicKey  string
	VAPIDPrivateKey string

	// Snowflake
	SnowflakeMachineID int64
}

// Load reads .env (if present) then environment variables and returns a Config.
func Load() (*Config, error) {
	// Load .env file if it exists (ignore error if not found in production)
	_ = godotenv.Load()

	cfg := &Config{
		AppEnv: getEnv("APP_ENV", "development"),
		Port:   getEnv("PORT", "8080"),
		WSPort: getEnv("WS_PORT", "4747"),

		JWTSecret: mustGetEnv("JWT_SECRET"),

		DBHost:     getEnv("DB_HOST", "localhost"),
		DBPort:     getEnv("DB_PORT", "5432"),
		DBName:     getEnv("DB_NAME", "ghenapp"),
		DBUser:     getEnv("DB_USER", "ghen"),
		DBPassword: getEnv("DB_PASSWORD", "devpassword"),
		DBSSLMode:  getEnv("DB_SSLMODE", "disable"),

		RedisAddr:     getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword: getEnv("REDIS_PASSWORD", ""),

		UploadPath: getEnv("UPLOAD_PATH", "./uploads"),

		VAPIDPublicKey:  getEnv("VAPID_PUBLIC_KEY", ""),
		VAPIDPrivateKey: getEnv("VAPID_PRIVATE_KEY", ""),
	}

	// Parse durations
	var err error
	cfg.JWTExpiry, err = time.ParseDuration(getEnv("JWT_EXPIRY", "15m"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_EXPIRY: %w", err)
	}
	cfg.RefreshTokenExpiry, err = time.ParseDuration(getEnv("REFRESH_TOKEN_EXPIRY", "720h"))
	if err != nil {
		return nil, fmt.Errorf("invalid REFRESH_TOKEN_EXPIRY: %w", err)
	}

	// Parse ints
	cfg.RedisDB, err = strconv.Atoi(getEnv("REDIS_DB", "0"))
	if err != nil {
		return nil, fmt.Errorf("invalid REDIS_DB: %w", err)
	}
	cfg.MaxUploadBytes, err = strconv.ParseInt(getEnv("MAX_UPLOAD_BYTES", "2097152"), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid MAX_UPLOAD_BYTES: %w", err)
	}
	cfg.SnowflakeMachineID, err = strconv.ParseInt(getEnv("SNOWFLAKE_MACHINE_ID", "1"), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid SNOWFLAKE_MACHINE_ID: %w", err)
	}

	return cfg, nil
}

// DSN returns the PostgreSQL connection string.
func (c *Config) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		c.DBHost, c.DBPort, c.DBUser, c.DBPassword, c.DBName, c.DBSSLMode,
	)
}

// IsDevelopment returns true when running in development mode.
func (c *Config) IsDevelopment() bool {
	return c.AppEnv == "development"
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustGetEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required environment variable %q is not set", key))
	}
	return v
}
