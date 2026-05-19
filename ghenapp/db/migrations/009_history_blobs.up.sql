-- Migration: 009_history_blobs.up.sql
-- Per-user encrypted history blobs for cross-device message recovery.
-- The server stores opaque ciphertexts it cannot read.
-- Key derivation happens entirely on the client using the user's identity key.

CREATE TABLE message_history_blobs (
    message_id  BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    blob        BYTEA       NOT NULL,   -- XSalsa20-Poly1305 encrypted plaintext
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX idx_history_blobs_user ON message_history_blobs (user_id);
