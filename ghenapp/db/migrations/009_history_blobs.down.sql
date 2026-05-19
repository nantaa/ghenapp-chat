-- Migration: 009_history_blobs.down.sql
DROP INDEX IF EXISTS idx_history_blobs_user;
DROP TABLE IF EXISTS message_history_blobs;
