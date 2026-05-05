-- 004_groups_conversation_id.down.sql
ALTER TABLE groups DROP COLUMN IF EXISTS conversation_id;
