ALTER TABLE messages
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS read_at;
