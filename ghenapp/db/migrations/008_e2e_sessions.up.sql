-- 008_e2e_sessions.up.sql
-- Stores the X3DH session initiation parameters from 0x02 frames.
-- Only PUBLIC key material is stored — no secret keys, E2E intact.
-- The server extracts these from the payload when a 0x02 frame arrives,
-- allowing recipients to recover their session from REST (not re-delivery).

CREATE TABLE e2e_sessions (
    conversation_id UUID        NOT NULL,
    sender_id       UUID        NOT NULL,
    sender_ik_pub   BYTEA       NOT NULL,  -- 32 bytes: sender Ed25519 identity pub
    sender_ek_pub   BYTEA       NOT NULL,  -- 32 bytes: sender X25519 ephemeral pub
    opk_pub         BYTEA,                 -- 32 bytes: one-time prekey used, or NULL
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id)          -- latest session wins (UPSERT)
);
