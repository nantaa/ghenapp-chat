// Hand-written sqlc-style generated file for message_history_blobs.
// Mirrors the pattern of messages.sql.go — keep in sync with models.go.

package db

import (
	"context"

	"github.com/google/uuid"
)

// MessageHistoryBlob is the row type for message_history_blobs.
type MessageHistoryBlob struct {
	MessageID int64     `json:"message_id"`
	UserID    uuid.UUID `json:"user_id"`
	Blob      []byte    `json:"blob"`
}

const upsertHistoryBlob = `-- name: UpsertHistoryBlob :exec
INSERT INTO message_history_blobs (message_id, user_id, blob)
VALUES ($1, $2, $3)
ON CONFLICT (message_id, user_id) DO UPDATE SET blob = EXCLUDED.blob
`

type UpsertHistoryBlobParams struct {
	MessageID int64     `json:"message_id"`
	UserID    uuid.UUID `json:"user_id"`
	Blob      []byte    `json:"blob"`
}

func (q *Queries) UpsertHistoryBlob(ctx context.Context, arg UpsertHistoryBlobParams) error {
	_, err := q.db.ExecContext(ctx, upsertHistoryBlob, arg.MessageID, arg.UserID, arg.Blob)
	return err
}

const getHistoryBlobsForUser = `-- name: GetHistoryBlobsForUser :many
SELECT message_id, blob
FROM message_history_blobs
WHERE user_id = $1
  AND message_id = ANY($2::bigint[])
`

type GetHistoryBlobsForUserRow struct {
	MessageID int64  `json:"message_id"`
	Blob      []byte `json:"blob"`
}

func (q *Queries) GetHistoryBlobsForUser(ctx context.Context, userID uuid.UUID, messageIDs []int64) ([]GetHistoryBlobsForUserRow, error) {
	rows, err := q.db.QueryContext(ctx, getHistoryBlobsForUser, userID, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []GetHistoryBlobsForUserRow
	for rows.Next() {
		var i GetHistoryBlobsForUserRow
		if err := rows.Scan(&i.MessageID, &i.Blob); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return items, rows.Err()
}

const deleteHistoryBlobsForUser = `-- name: DeleteHistoryBlobsForUser :exec
DELETE FROM message_history_blobs WHERE user_id = $1
`

func (q *Queries) DeleteHistoryBlobsForUser(ctx context.Context, userID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, deleteHistoryBlobsForUser, userID)
	return err
}
