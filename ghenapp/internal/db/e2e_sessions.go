package db

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

// E2ESession holds the X3DH public key material for a conversation session.
// Only public keys are stored — no secret material is exposed.
type E2ESession struct {
	ConversationID uuid.UUID
	SenderID       uuid.UUID
	SenderIKPub    []byte // 32 bytes: sender Ed25519 identity pub
	SenderEKPub    []byte // 32 bytes: sender X25519 ephemeral pub
	OPKPub         []byte // 32 bytes or nil: one-time prekey used
}

// UpsertE2ESession stores (or replaces) the X3DH session params for a conversation.
// Called server-side whenever a 0x02 frame is received so recipients can
// always recover their session via REST without needing frame re-delivery.
func (q *Queries) UpsertE2ESession(ctx context.Context, s E2ESession) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO e2e_sessions (conversation_id, sender_id, sender_ik_pub, sender_ek_pub, opk_pub)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (conversation_id) DO UPDATE
		  SET sender_id    = EXCLUDED.sender_id,
		      sender_ik_pub = EXCLUDED.sender_ik_pub,
		      sender_ek_pub = EXCLUDED.sender_ek_pub,
		      opk_pub       = EXCLUDED.opk_pub,
		      created_at    = NOW()
	`, s.ConversationID, s.SenderID, s.SenderIKPub, s.SenderEKPub, s.OPKPub)
	return err
}

// GetE2ESession fetches stored X3DH params for a conversation.
// Returns sql.ErrNoRows if no session has been established yet.
func (q *Queries) GetE2ESession(ctx context.Context, conversationID uuid.UUID) (E2ESession, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT conversation_id, sender_id, sender_ik_pub, sender_ek_pub, opk_pub
		FROM e2e_sessions
		WHERE conversation_id = $1
	`, conversationID)
	var s E2ESession
	var opkPub []byte
	err := row.Scan(&s.ConversationID, &s.SenderID, &s.SenderIKPub, &s.SenderEKPub, &opkPub)
	if err != nil {
		return E2ESession{}, err
	}
	s.OPKPub = opkPub
	return s, nil
}

// GetE2ESessionByConvIDStr is a convenience wrapper accepting a string UUID.
func (q *Queries) GetE2ESessionByConvIDStr(ctx context.Context, convIDStr string) (E2ESession, error) {
	cid, err := uuid.Parse(convIDStr)
	if err != nil {
		return E2ESession{}, err
	}
	return q.GetE2ESession(ctx, cid)
}

// IsE2ESessionNoRows returns true when the error means no session was found.
func IsE2ESessionNoRows(err error) bool {
	return err == sql.ErrNoRows
}
