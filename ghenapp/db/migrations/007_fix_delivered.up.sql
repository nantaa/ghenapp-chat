-- 007_fix_delivered.up.sql
-- Mark ALL existing messages as delivered so DeliverPending stops
-- re-flooding them on every reconnect. Safe to run multiple times.
UPDATE messages
SET delivered = TRUE,
    delivered_at = COALESCE(delivered_at, NOW())
WHERE delivered = FALSE
   OR delivered IS NULL;
