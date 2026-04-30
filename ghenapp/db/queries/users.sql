-- name: CreateUser :one
INSERT INTO users (username, public_key)
VALUES ($1, $2)
RETURNING *;

-- name: GetUserByUsername :one
SELECT * FROM users
WHERE username = $1
LIMIT 1;

-- name: GetUserByID :one
SELECT * FROM users
WHERE id = $1
LIMIT 1;

-- name: UpdateLastSeen :exec
UPDATE users
SET last_seen_at = NOW()
WHERE id = $1;

-- name: UpdateUserTier :exec
UPDATE users
SET tier = $2,
    tier_expires_at = $3
WHERE id = $1;

-- name: UpdateUserProfile :one
UPDATE users
SET display_name = $2,
    discoverable = $3
WHERE id = $1
RETURNING *;

-- name: IncrementKeyVersion :exec
UPDATE users
SET key_version  = key_version + 1,
    public_key   = $2
WHERE id = $1;

-- name: SearchUsers :many
SELECT id, username, display_name, discoverable, created_at
FROM users
WHERE username ILIKE $1
  AND discoverable = TRUE
LIMIT 20;
