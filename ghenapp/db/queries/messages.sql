-- name: InsertMessage :one
INSERT INTO messages (id, conversation_id, sender_id, payload, msg_type, timestamp, ttl_expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE
  SET payload       = EXCLUDED.payload,
      msg_type      = EXCLUDED.msg_type,
      timestamp     = EXCLUDED.timestamp,
      ttl_expires_at = EXCLUDED.ttl_expires_at
RETURNING *;

-- name: GetMessagesByConversation :many
SELECT * FROM messages
WHERE conversation_id = $1
ORDER BY timestamp DESC
LIMIT $2 OFFSET $3;

-- name: GetUndeliveredMessages :many
SELECT * FROM messages
WHERE conversation_id = $1
  AND delivered = FALSE
ORDER BY timestamp ASC;

-- name: MarkMessageDelivered :exec
UPDATE messages
SET delivered = TRUE, delivered_at = NOW()
WHERE id = $1;

-- name: MarkMessageRead :exec
UPDATE messages
SET read_at = NOW()
WHERE id = $1;

-- name: MarkConversationMessagesDelivered :exec
UPDATE messages
SET delivered = TRUE
WHERE conversation_id = $1
  AND delivered = FALSE;

-- name: DeleteExpiredMessages :exec
DELETE FROM messages
WHERE ttl_expires_at IS NOT NULL
  AND ttl_expires_at < NOW();

-- name: PurgeOldMessages :exec
DELETE FROM messages
WHERE created_at < NOW() - INTERVAL '3 years';

