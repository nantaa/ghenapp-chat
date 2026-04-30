-- Database Indexes
-- Migration: 002_indexes.up.sql

-- Fast conversation message lookup (paginated, newest first)
CREATE INDEX idx_messages_conversation
    ON messages(conversation_id, timestamp DESC);

-- TTL background cleanup job
CREATE INDEX idx_messages_ttl
    ON messages(ttl_expires_at)
    WHERE ttl_expires_at IS NOT NULL;

-- X3DH prekey fetch (one available key per user per type)
CREATE INDEX idx_prekeys_user
    ON prekeys(user_id, key_type, used);

-- Username lookup (registration + login + user search)
CREATE INDEX idx_users_username
    ON users(username);

-- Undelivered message fetch on reconnect
CREATE INDEX idx_messages_undelivered
    ON messages(conversation_id, delivered)
    WHERE delivered = FALSE;

-- Tier expiry check
CREATE INDEX idx_users_tier_expiry
    ON users(tier_expires_at)
    WHERE tier_expires_at IS NOT NULL;
