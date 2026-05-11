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
	convIDs, err := q.GetConversationsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	var details []ConversationDetail
	for _, c := range convIDs {
		cid := c.ID
		convType := c.Type
		
		membersRows, err := q.GetGroupMembers(ctx, cid)
		var members []uuid.UUID
		if err == nil {
			for _, m := range membersRows {
				members = append(members, m.ID)
			}
		} else {
			// fallback if it's not a group, or try conversation_members
			rows, err := q.db.QueryContext(ctx, "SELECT user_id FROM conversation_members WHERE conversation_id=$1", cid)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var uid uuid.UUID
					if rows.Scan(&uid) == nil {
						members = append(members, uid)
					}
				}
			}
		}
		
		usernames := make(map[uuid.UUID]string)
		for _, uid := range members {
			var uname string
			if err2 := q.db.QueryRowContext(ctx,
				`SELECT username FROM users WHERE id=$1`, uid,
			).Scan(&uname); err2 == nil {
				usernames[uid] = uname
			}
		}
		details = append(details, ConversationDetail{
			ID:              cid,
			Type:            convType,
			Members:         members,
			MemberUsernames: usernames,
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
