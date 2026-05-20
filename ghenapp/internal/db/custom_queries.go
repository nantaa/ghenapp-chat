package db

import (
	"context"

	"github.com/google/uuid"
)

// DB exposes the underlying DBTX (useful for raw queries or transactions in handlers).
func (q *Queries) DB() DBTX {
	return q.db
}

func (q *Queries) GetConversationMembers(ctx context.Context, convID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT user_id FROM conversation_members WHERE conversation_id=$1`,
		convID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var members []uuid.UUID
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err == nil {
			members = append(members, uid)
		}
	}
	return members, rows.Err()
}

// ConversationDetail holds enough info for the sidebar conversation list.
type ConversationDetail struct {
	ID              uuid.UUID
	Type            string
	Members         []uuid.UUID
	MemberUsernames map[uuid.UUID]string
}

// GetUserConversationsWithDetails returns conversation metadata and member lists
// for all conversations the user belongs to (used by the REST history endpoint).
func (q *Queries) GetUserConversationsWithDetails(ctx context.Context, userID uuid.UUID) ([]ConversationDetail, error) {
	// Single JOIN query: get all conversations + all their members + all usernames at once.
	// This replaces the fragile N+1 loop that could silently return empty usernames.
	rows, err := q.db.QueryContext(ctx, `
		SELECT c.id, c.type, u.id AS member_id, u.username
		FROM conversations c
		JOIN conversation_members cm ON c.id = cm.conversation_id
		JOIN users u ON cm.user_id = u.id
		WHERE c.id IN (
			SELECT conversation_id FROM conversation_members WHERE user_id = $1
		)
		ORDER BY c.id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Build map: convID → ConversationDetail
	type entry struct {
		id      uuid.UUID
		ctype   string
		members []uuid.UUID
		names   map[uuid.UUID]string
	}
	ordered := []uuid.UUID{} // preserve insertion order
	byID := map[uuid.UUID]*entry{}

	for rows.Next() {
		var convID, memberID uuid.UUID
		var convType, username string
		if err := rows.Scan(&convID, &convType, &memberID, &username); err != nil {
			continue
		}
		e, ok := byID[convID]
		if !ok {
			e = &entry{id: convID, ctype: convType, names: map[uuid.UUID]string{}}
			byID[convID] = e
			ordered = append(ordered, convID)
		}
		e.members = append(e.members, memberID)
		e.names[memberID] = username
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	details := make([]ConversationDetail, 0, len(ordered))
	for _, id := range ordered {
		e := byID[id]
		details = append(details, ConversationDetail{
			ID:              e.id,
			Type:            e.ctype,
			Members:         e.members,
			MemberUsernames: e.names,
		})
	}
	return details, nil
}

// GetConversationMessages returns the last `limit` messages for a conversation,
// ordered oldest first. Used by the REST history endpoint.
func (q *Queries) GetConversationMessages(ctx context.Context, conversationID uuid.UUID, limit int) ([]Message, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT id,conversation_id,sender_id,payload,msg_type,timestamp,delivered
		 FROM messages
		 WHERE conversation_id=$1
		 ORDER BY timestamp DESC
		 LIMIT $2`,
		conversationID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var msgs []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Payload, &m.MsgType, &m.Timestamp, &m.Delivered); err != nil {
			continue
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Reverse so result is oldest-first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}
