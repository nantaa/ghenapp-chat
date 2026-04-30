-- name: CreateUpload :one
INSERT INTO uploads (uploader_id, filename, mime_type, size_bytes, storage_path)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetUploadByID :one
SELECT * FROM uploads WHERE id = $1;
