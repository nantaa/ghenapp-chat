-- name: CreateSession :one
INSERT INTO sessions (user_id)
VALUES ($1)
RETURNING *;

-- name: GetSessionByID :one
SELECT * FROM sessions WHERE id = $1;

-- name: RevokeSession :exec
UPDATE sessions
SET revoked = TRUE
WHERE id = $1;

-- name: UpdateSessionLastUsed :exec
UPDATE sessions
SET last_used_at = NOW()
WHERE id = $1;
