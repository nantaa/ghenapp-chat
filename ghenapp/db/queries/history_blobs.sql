-- name: UpsertHistoryBlob :exec
INSERT INTO message_history_blobs (message_id, user_id, blob)
VALUES ($1, $2, $3)
ON CONFLICT (message_id, user_id) DO UPDATE SET blob = EXCLUDED.blob;

-- name: GetHistoryBlobsForUser :many
SELECT message_id, blob
FROM message_history_blobs
WHERE user_id = $1
  AND message_id = ANY($2::bigint[]);

-- name: DeleteHistoryBlobsForUser :exec
DELETE FROM message_history_blobs
WHERE user_id = $1;
