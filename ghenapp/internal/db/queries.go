package db

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

// Queries holds the database connection and provides all query methods.
// This is a hand-written wrapper until sqlc generate runs with a live DB.
type Queries struct {
	db *sql.DB
}

func New(db *sql.DB) *Queries {
	return &Queries{db: db}
}

func (q *Queries) DB() *sql.DB {
	return q.db
}

// ─── Users ───────────────────────────────────────────────────────────────────

type CreateUserParams struct {
	Username  string
	PublicKey []byte
}

type User struct {
	ID           uuid.UUID
	Username     string
	DisplayName  sql.NullString
	PublicKey    []byte
	KeyVersion   int32
	Tier         string
	Discoverable bool
}

func (q *Queries) CreateUser(ctx context.Context, arg CreateUserParams) (User, error) {
	row := q.db.QueryRowContext(ctx,
		`INSERT INTO users (username, public_key) VALUES ($1,$2) RETURNING id,username,display_name,public_key,key_version,tier,discoverable`,
		arg.Username, arg.PublicKey,
	)
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PublicKey, &u.KeyVersion, &u.Tier, &u.Discoverable)
	return u, err
}

func (q *Queries) GetUserByUsername(ctx context.Context, username string) (User, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id,username,display_name,public_key,key_version,tier,discoverable FROM users WHERE username=$1`,
		username,
	)
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PublicKey, &u.KeyVersion, &u.Tier, &u.Discoverable)
	return u, err
}

func (q *Queries) GetUserByID(ctx context.Context, id uuid.UUID) (User, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id,username,display_name,public_key,key_version,tier,discoverable FROM users WHERE id=$1`,
		id,
	)
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PublicKey, &u.KeyVersion, &u.Tier, &u.Discoverable)
	return u, err
}

func (q *Queries) UpdateLastSeen(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `UPDATE users SET last_seen_at=NOW() WHERE id=$1`, id)
	return err
}

func (q *Queries) UpdateUserTier(ctx context.Context, id uuid.UUID, tier string, expiresAt sql.NullTime) error {
	_, err := q.db.ExecContext(ctx, `UPDATE users SET tier=$2, tier_expires_at=$3 WHERE id=$1`, id, tier, expiresAt)
	return err
}

type UpdateUserProfileParams struct {
	ID           uuid.UUID
	DisplayName  sql.NullString
	Discoverable bool
}

func (q *Queries) UpdateUserProfile(ctx context.Context, arg UpdateUserProfileParams) (User, error) {
	row := q.db.QueryRowContext(ctx,
		`UPDATE users SET display_name=$2, discoverable=$3 WHERE id=$1 RETURNING id,username,display_name,public_key,key_version,tier,discoverable`,
		arg.ID, arg.DisplayName, arg.Discoverable,
	)
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.PublicKey, &u.KeyVersion, &u.Tier, &u.Discoverable)
	return u, err
}

// ─── Prekeys ─────────────────────────────────────────────────────────────────

type Prekey struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	KeyType   string
	PublicKey []byte
	Signature []byte
	Used      bool
}

type InsertSignedPrekeyParams struct {
	UserID    uuid.UUID
	PublicKey []byte
	Signature []byte
}

func (q *Queries) InsertSignedPrekey(ctx context.Context, arg InsertSignedPrekeyParams) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO prekeys (user_id, key_type, public_key, signature) VALUES ($1,'signed',$2,$3)`,
		arg.UserID, arg.PublicKey, arg.Signature,
	)
	return err
}

type InsertOneTimePrekeyParams struct {
	UserID    uuid.UUID
	PublicKey []byte
}

func (q *Queries) InsertOneTimePrekey(ctx context.Context, arg InsertOneTimePrekeyParams) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO prekeys (user_id, key_type, public_key) VALUES ($1,'onetime',$2)`,
		arg.UserID, arg.PublicKey,
	)
	return err
}

type GetAvailablePrekeyParams struct {
	UserID  uuid.UUID
	KeyType string
}

func (q *Queries) GetAvailablePrekey(ctx context.Context, arg GetAvailablePrekeyParams) (Prekey, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id,user_id,key_type,public_key,signature,used FROM prekeys WHERE user_id=$1 AND key_type=$2 AND used=FALSE ORDER BY created_at ASC LIMIT 1`,
		arg.UserID, arg.KeyType,
	)
	var p Prekey
	err := row.Scan(&p.ID, &p.UserID, &p.KeyType, &p.PublicKey, &p.Signature, &p.Used)
	return p, err
}

func (q *Queries) GetSignedPrekey(ctx context.Context, userID uuid.UUID) (Prekey, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id,user_id,key_type,public_key,signature,used FROM prekeys WHERE user_id=$1 AND key_type='signed' ORDER BY created_at DESC LIMIT 1`,
		userID,
	)
	var p Prekey
	err := row.Scan(&p.ID, &p.UserID, &p.KeyType, &p.PublicKey, &p.Signature, &p.Used)
	return p, err
}

func (q *Queries) MarkPrekeyUsed(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `UPDATE prekeys SET used=TRUE WHERE id=$1`, id)
	return err
}

// ─── Messages ─────────────────────────────────────────────────────────────────

type Message struct {
	ID             int64
	ConversationID uuid.UUID
	SenderID       uuid.UUID
	Payload        []byte
	MsgType        string
	Timestamp      int64
	Delivered      bool
}

type InsertMessageParams struct {
	ID             int64
	ConversationID uuid.UUID
	SenderID       uuid.UUID
	Payload        []byte
	MsgType        string
	Timestamp      int64
	TtlExpiresAt   sql.NullTime
}

func (q *Queries) InsertMessage(ctx context.Context, arg InsertMessageParams) (Message, error) {
	row := q.db.QueryRowContext(ctx,
		`INSERT INTO messages (id,conversation_id,sender_id,payload,msg_type,timestamp,ttl_expires_at)
		 VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7)
		 RETURNING id,conversation_id,sender_id,payload,msg_type,EXTRACT(EPOCH FROM timestamp)*1000,delivered`,
		arg.ID, arg.ConversationID, arg.SenderID, arg.Payload, arg.MsgType, arg.Timestamp, arg.TtlExpiresAt,
	)
	var m Message
	err := row.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Payload, &m.MsgType, &m.Timestamp, &m.Delivered)
	return m, err
}

func (q *Queries) GetUndeliveredMessages(ctx context.Context, conversationID uuid.UUID) ([]Message, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT id,conversation_id,sender_id,payload,msg_type,EXTRACT(EPOCH FROM timestamp)*1000,delivered
		 FROM messages WHERE conversation_id=$1 AND delivered=FALSE ORDER BY timestamp ASC`,
		conversationID,
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
	return msgs, rows.Err()
}

func (q *Queries) MarkMessageDelivered(ctx context.Context, id int64) error {
	_, err := q.db.ExecContext(ctx, `UPDATE messages SET delivered=TRUE WHERE id=$1`, id)
	return err
}

func (q *Queries) DeleteExpiredMessages(ctx context.Context) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM messages WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at < NOW()`)
	return err
}

// ─── Conversations ────────────────────────────────────────────────────────────

func (q *Queries) CreateConversation(ctx context.Context, convType string) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.db.QueryRowContext(ctx, `INSERT INTO conversations (type) VALUES ($1) RETURNING id`, convType).Scan(&id)
	return id, err
}

func (q *Queries) AddConversationMember(ctx context.Context, convID, userID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
		convID, userID,
	)
	return err
}

// ─── Payments ────────────────────────────────────────────────────────────────

type Payment struct {
	ID           uuid.UUID
	UserID       uuid.UUID
	AmountIDR    int32
	Method       string
	Status       string
	PeriodMonths int32
}

type CreatePaymentParams struct {
	UserID       uuid.UUID
	AmountIDR    int32
	Method       string
	PeriodMonths int32
}

func (q *Queries) CreatePayment(ctx context.Context, arg CreatePaymentParams) (Payment, error) {
	row := q.db.QueryRowContext(ctx,
		`INSERT INTO payments (user_id,amount_idr,method,period_months) VALUES ($1,$2,$3,$4) RETURNING id,user_id,amount_idr,method,status,period_months`,
		arg.UserID, arg.AmountIDR, arg.Method, arg.PeriodMonths,
	)
	var p Payment
	err := row.Scan(&p.ID, &p.UserID, &p.AmountIDR, &p.Method, &p.Status, &p.PeriodMonths)
	return p, err
}

func (q *Queries) ConfirmPayment(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `UPDATE payments SET status='paid', paid_at=NOW() WHERE id=$1`, id)
	return err
}

func (q *Queries) GetPendingPayments(ctx context.Context) ([]Payment, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT id,user_id,amount_idr,method,status,period_months FROM payments WHERE status='pending' ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var payments []Payment
	for rows.Next() {
		var p Payment
		if err := rows.Scan(&p.ID, &p.UserID, &p.AmountIDR, &p.Method, &p.Status, &p.PeriodMonths); err != nil {
			continue
		}
		payments = append(payments, p)
	}
	return payments, rows.Err()
}

// ─── Uploads ─────────────────────────────────────────────────────────────────

type CreateUploadParams struct {
	UploaderID  uuid.UUID
	Filename    string
	MimeType    string
	SizeBytes   int32
	StoragePath string
}

type Upload struct {
	ID          uuid.UUID
	UploaderID  uuid.UUID
	Filename    string
	MimeType    string
	SizeBytes   int32
	StoragePath string
}

func (q *Queries) CreateUpload(ctx context.Context, arg CreateUploadParams) (Upload, error) {
	row := q.db.QueryRowContext(ctx,
		`INSERT INTO uploads (uploader_id,filename,mime_type,size_bytes,storage_path) VALUES ($1,$2,$3,$4,$5) RETURNING id,uploader_id,filename,mime_type,size_bytes,storage_path`,
		arg.UploaderID, arg.Filename, arg.MimeType, arg.SizeBytes, arg.StoragePath,
	)
	var u Upload
	err := row.Scan(&u.ID, &u.UploaderID, &u.Filename, &u.MimeType, &u.SizeBytes, &u.StoragePath)
	return u, err
}

func (q *Queries) GetUploadByID(ctx context.Context, id uuid.UUID) (Upload, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT id,uploader_id,filename,mime_type,size_bytes,storage_path FROM uploads WHERE id=$1`,
		id,
	)
	var u Upload
	err := row.Scan(&u.ID, &u.UploaderID, &u.Filename, &u.MimeType, &u.SizeBytes, &u.StoragePath)
	return u, err
}
