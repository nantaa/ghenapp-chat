-- name: CreatePayment :one
INSERT INTO payments (user_id, amount_idr, method, period_months)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetPaymentByID :one
SELECT * FROM payments WHERE id = $1;

-- name: GetPaymentsByUser :many
SELECT * FROM payments
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: ConfirmPayment :exec
UPDATE payments
SET status  = 'paid',
    paid_at = NOW()
WHERE id = $1;

-- name: GetPendingPayments :many
SELECT p.*, u.username
FROM payments p
JOIN users u ON u.id = p.user_id
WHERE p.status = 'pending'
ORDER BY p.created_at ASC;
