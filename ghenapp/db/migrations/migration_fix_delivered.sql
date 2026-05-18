-- migration_fix_delivered.sql
-- Purpose: Mark ALL existing messages as delivered.
--
-- Why: The old echo bug caused many messages to never be marked delivered
-- (because the delivery path was broken). DeliverPending re-sends every
-- undelivered message on every WebSocket reconnect, causing a flood of
-- old encrypted frames that cannot be decrypted (corrupted ratchet state).
--
-- Run ONCE on VPS after deploying the latest server binary:
--   psql -U <db_user> -d <db_name> -f migration_fix_delivered.sql
--
-- Safe to re-run (UPDATE is idempotent).

BEGIN;

UPDATE messages
SET delivered = TRUE,
    delivered_at = COALESCE(delivered_at, NOW())
WHERE delivered = FALSE
   OR delivered IS NULL;

-- Verify
SELECT
  COUNT(*) FILTER (WHERE delivered = TRUE)  AS delivered_count,
  COUNT(*) FILTER (WHERE delivered = FALSE) AS still_undelivered
FROM messages;

COMMIT;
