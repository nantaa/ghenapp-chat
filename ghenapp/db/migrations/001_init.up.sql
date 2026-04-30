-- GhenApp Initial Schema Migration
-- Migration: 001_init.up.sql

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    display_name    VARCHAR(64),
    public_key      BYTEA NOT NULL,             -- Ed25519 public key (32 bytes)
    key_version     INT DEFAULT 1,              -- increments on key change
    tier            VARCHAR(10) DEFAULT 'free', -- 'free' | 'premium'
    tier_expires_at TIMESTAMPTZ,
    discoverable    BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ
);

-- ─── Pre-keys (X3DH) ─────────────────────────────────────────────────────────
CREATE TABLE prekeys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    key_type    VARCHAR(10) NOT NULL,   -- 'signed' | 'onetime'
    public_key  BYTEA NOT NULL,
    signature   BYTEA,                  -- required for signed prekeys
    used        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Conversations ────────────────────────────────────────────────────────────
CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        VARCHAR(10) NOT NULL,   -- 'direct' | 'group'
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Conversation Members ─────────────────────────────────────────────────────
CREATE TABLE conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);

-- ─── Messages (Snowflake ID, auto-purge 3yr) ──────────────────────────────────
CREATE TABLE messages (
    id              BIGINT PRIMARY KEY,         -- Twitter Snowflake
    conversation_id UUID NOT NULL REFERENCES conversations ON DELETE CASCADE,
    sender_id       UUID REFERENCES users ON DELETE SET NULL,
    payload         BYTEA NOT NULL,             -- E2E encrypted blob (passthrough)
    msg_type        VARCHAR(20) NOT NULL,       -- TEXT|IMAGE|VIDEO|AUDIO|FILE|STICKER|REACTION|SYSTEM|CALL_SIGNAL
    timestamp       TIMESTAMPTZ NOT NULL,
    ttl_expires_at  TIMESTAMPTZ,                -- NULL = no expiry
    delivered       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Groups ──────────────────────────────────────────────────────────────────
CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    created_by  UUID REFERENCES users ON DELETE SET NULL,
    max_members INT DEFAULT 100,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Group Members ────────────────────────────────────────────────────────────
CREATE TABLE group_members (
    group_id    UUID NOT NULL REFERENCES groups ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    role        VARCHAR(10) DEFAULT 'member',   -- 'admin' | 'member'
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- ─── Invite Links ─────────────────────────────────────────────────────────────
CREATE TABLE invite_links (
    token       VARCHAR(32) PRIMARY KEY,
    group_id    UUID NOT NULL REFERENCES groups ON DELETE CASCADE,
    created_by  UUID REFERENCES users ON DELETE SET NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    max_uses    INT DEFAULT 0,                  -- 0 = unlimited
    use_count   INT DEFAULT 0,
    revoked     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── File Uploads ─────────────────────────────────────────────────────────────
CREATE TABLE uploads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploader_id  UUID REFERENCES users ON DELETE SET NULL,
    filename     VARCHAR(255),
    mime_type    VARCHAR(100),
    size_bytes   INT NOT NULL,                  -- enforced <= 2MB server-side
    storage_path TEXT NOT NULL,                 -- local VPS path
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Sessions (audit log — live state in Redis) ───────────────────────────────
CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked      BOOLEAN DEFAULT FALSE
);

-- ─── Payments ─────────────────────────────────────────────────────────────────
CREATE TABLE payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID REFERENCES users ON DELETE SET NULL,
    amount_idr     INT NOT NULL,                -- in Indonesian Rupiah
    method         VARCHAR(20) DEFAULT 'qr',   -- 'qr' | 'xendit'
    status         VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
    period_months  INT DEFAULT 1,
    paid_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
