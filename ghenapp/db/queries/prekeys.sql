-- name: InsertPrekeys :exec
INSERT INTO prekeys (user_id, key_type, public_key, signature)
SELECT $1, $2, unnest($3::bytea[]), unnest($4::bytea[]);

-- name: GetAvailablePrekey :one
SELECT * FROM prekeys
WHERE user_id = $1
  AND key_type = $2
  AND used = FALSE
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- name: MarkPrekeyUsed :exec
UPDATE prekeys
SET used = TRUE
WHERE id = $1;

-- name: GetSignedPrekey :one
SELECT * FROM prekeys
WHERE user_id = $1
  AND key_type = 'signed'
ORDER BY created_at DESC
LIMIT 1;

-- name: CountAvailableOneTimePrekeys :one
SELECT COUNT(*) FROM prekeys
WHERE user_id = $1
  AND key_type = 'onetime'
  AND used = FALSE;
