-- Rollback Initial Schema
-- Migration: 001_init.down.sql

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS uploads;
DROP TABLE IF EXISTS invite_links;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversation_members;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS prekeys;
DROP TABLE IF EXISTS users;
