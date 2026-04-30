-- name: CreateInviteLink :one
INSERT INTO invite_links (token, group_id, created_by, expires_at, max_uses)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetInviteLink :one
SELECT * FROM invite_links WHERE token = $1;

-- name: IncrementInviteLinkUseCount :exec
UPDATE invite_links
SET use_count = use_count + 1
WHERE token = $1;

-- name: RevokeInviteLink :exec
UPDATE invite_links
SET revoked = TRUE
WHERE token = $1;

-- name: GetGroupInviteLinks :many
SELECT * FROM invite_links
WHERE group_id = $1
ORDER BY created_at DESC;
