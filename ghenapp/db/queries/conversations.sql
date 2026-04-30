-- name: CreateConversation :one
INSERT INTO conversations (type)
VALUES ($1)
RETURNING *;

-- name: GetConversationByID :one
SELECT * FROM conversations WHERE id = $1;

-- name: AddConversationMember :exec
INSERT INTO conversation_members (conversation_id, user_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: GetConversationsForUser :many
SELECT c.*
FROM conversations c
JOIN conversation_members cm ON c.id = cm.conversation_id
WHERE cm.user_id = $1
ORDER BY c.created_at DESC;

-- name: GetDirectConversation :one
SELECT c.*
FROM conversations c
JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = $1
JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = $2
WHERE c.type = 'direct'
LIMIT 1;
