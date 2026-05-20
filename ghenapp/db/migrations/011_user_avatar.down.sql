-- Migration: 011_user_avatar.down.sql
ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
