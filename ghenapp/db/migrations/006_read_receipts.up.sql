-- Add delivery and read timestamps to messages for read receipt support.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ;
