-- 004_groups_conversation_id.up.sql
-- Add conversation_id column to groups table (missed in initial schema)
ALTER TABLE groups ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;
