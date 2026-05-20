-- Migration: 010_user_avatar.up.sql
-- Adds avatar_url to users for profile photo support.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT NULL;
