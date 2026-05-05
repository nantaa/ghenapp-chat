-- 005_push_subscriptions.up.sql
-- Stores browser Web Push subscriptions for offline notification delivery.
-- A user may have multiple subscriptions (multiple devices/browsers).

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint       TEXT        NOT NULL,
    p256dh         TEXT        NOT NULL,  -- Base64url encoded client public key
    auth           TEXT        NOT NULL,  -- Base64url encoded auth secret
    user_agent     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at   TIMESTAMPTZ,
    UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
