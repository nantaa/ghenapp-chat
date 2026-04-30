-- Rollback Indexes
-- Migration: 002_indexes.down.sql

DROP INDEX IF EXISTS idx_users_tier_expiry;
DROP INDEX IF EXISTS idx_messages_undelivered;
DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_prekeys_user;
DROP INDEX IF EXISTS idx_messages_ttl;
DROP INDEX IF EXISTS idx_messages_conversation;
