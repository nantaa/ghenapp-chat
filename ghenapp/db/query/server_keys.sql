-- name: GetServerKey :one
SELECT key_data
FROM server_keys
WHERE id = $1 LIMIT 1;

-- name: SetServerKey :exec
INSERT INTO server_keys (id, key_data, updated_at)
VALUES ($1, $2, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE 
SET key_data = EXCLUDED.key_data,
    updated_at = CURRENT_TIMESTAMP;
