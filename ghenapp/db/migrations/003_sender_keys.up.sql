-- 003_sender_keys.up.sql
-- Sender Keys table for group E2E encryption (Signal Protocol Sender Keys)
CREATE TABLE IF NOT EXISTS sender_keys (
    group_id     UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id    UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    recipient_id UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    key_blob     BYTEA       NOT NULL,  -- E2E encrypted sender key blob (server never decrypts)
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, sender_id, recipient_id)
);

CREATE INDEX idx_sender_keys_group_recipient ON sender_keys(group_id, recipient_id);
