-- name: CreateGroup :one
INSERT INTO groups (name, description, created_by)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetGroupByID :one
SELECT * FROM groups WHERE id = $1;

-- name: AddGroupMember :exec
INSERT INTO group_members (group_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: RemoveGroupMember :exec
DELETE FROM group_members
WHERE group_id = $1 AND user_id = $2;

-- name: GetGroupMembers :many
SELECT u.id, u.username, u.display_name, gm.role, gm.joined_at
FROM group_members gm
JOIN users u ON u.id = gm.user_id
WHERE gm.group_id = $1;

-- name: GetGroupMember :one
SELECT * FROM group_members
WHERE group_id = $1 AND user_id = $2;

-- name: IsGroupAdmin :one
SELECT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = $1
      AND user_id = $2
      AND role = 'admin'
) AS is_admin;

-- name: CountGroupMembers :one
SELECT COUNT(*) FROM group_members WHERE group_id = $1;
