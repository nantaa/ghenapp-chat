<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# check [https://github.com/nantaa/ghenapp-chat](https://github.com/nantaa/ghenapp-chat) and analyze why always invalid edPk length when adding user to chat to

The “invalid edPk length” is coming from the E2E‑crypto path when you start a new DM, not from the UI itself. It’s effectively libsodium telling you that one of the Ed25519 public keys it received is **not 32 bytes long**, so X3DH cannot run.

Below is what actually happens in your code and why this will “always” fail for certain users.

***

## Where the error is triggered

1. On “New Conversation”, `handleNewDM` prompts for a username and then calls `initiateSession(user.username, target, convId)`. If anything throws, you show:
`alert("Failed to open conversation: " + err.message)` – this is exactly the dialog in your screenshot.
2. `initiateSession`:
    - Loads your own private key from IndexedDB via `loadPrivateKey`.
    - Calls `api.getPrekeys(recipientUsername)` to fetch the other user’s prekey bundle.
    - Then decodes the keys and runs X3DH:

```ts
const recipientIdentityPub = decodePubKey(bundle.public_key, `"${recipientUsername}" identity key`)
const recipientSignedPrekey = decodePubKey(bundle.signed_prekey.public_key, `"${recipientUsername}" signed prekey`)
const recipientOnetimePrekey = bundle.onetime_prekey?.public_key?.length === 32
  ? new Uint8Array(bundle.onetime_prekey.public_key)
  : undefined
const { masterSecret } = await x3dhInitiate({ ... })
```

3. `x3dhInitiate` then calls libsodium’s `crypto_sign_ed25519_pk_to_curve25519` on each Ed25519 public key. That function **requires exactly 32 bytes** and throws if the length is wrong.
4. That error bubbles back to `handleNewDM`, which produces the alert. Since the string “invalid edPk length” does **not** appear anywhere in your repo, it’s effectively libsodium’s validation error being surfaced in some form.

***

## Where those keys come from

Backend `/api/v1/prekeys/:username`:

- `GetPrekeys` returns:

```go
c.JSON(http.StatusOK, gin.H{
  "user_id":       target.ID,
  "username":      target.Username,
  "public_key":    b2i(target.PublicKey),
  "key_version":   target.KeyVersion,
  "signed_prekey": gin.H{"public_key": b2i(signed.PublicKey), "signature": b2i(signed.Signature)},
  "onetime_prekey": ...,
})
```

`b2i` just converts each byte to an int; length is preserved.
- `Register` only accepts a `public_key` whose length equals `ed25519.PublicKeySize (32)` before inserting into `users.public_key`.
- `UploadPrekeys` verifies the signed prekey using `VerifySignedPrekey`, which also enforces `len(identityPublicKey) == 32` and `len(signedPrekeyPublic) == 32`.

So **if everything was created with the current code**, all three public keys (identity, signed prekey, onetime prekey) should be 32 bytes and X3DH should not fail on length.

***

## Why you’re seeing “always invalid edPk length”

Given the above, the only realistic way to get that error is:

- The **stored key data for the user you’re trying to chat with is not a 32‑byte Ed25519 public key**, even though the current code expects it, **or**
- You’re running an older frontend build that doesn’t use the current `decodePubKey` guard and passes malformed arrays straight into libsodium.

In practice that usually happens in one of these scenarios:

1. **Old users created with a previous schema/encoding**

Before you added the strict checks and the current TS client, some users may have been registered with keys stored in a different format (e.g., hex/base64 string converted to bytes, or a 64‑byte key mistakenly saved as “public key”). Those rows will now produce wrong‑length arrays via `b2i(...)` → `decodePubKey`/`x3dhInitiate` → libsodium “invalid Ed25519 public key length” when you try to start a DM with them.
2. **Corrupted or manually seeded data**

Any manual insert/seeding into `users`, `signed_prekeys`, or `one_time_prekeys` that didn’t respect the 32‑byte requirement will behave the same way: JSON sends a number[] longer/shorter than 32, and X3DH explodes.
3. **Deployed frontend out of sync**

The repo currently includes `decodePubKey` with nice error messages like
`"\"alice\" identity key: expected 32 bytes but got X ..."`.
Your screenshot shows a shorter, libsodium‑style message (“invalid edPk length”), which strongly suggests the live build is older than this commit and:
    - Does **not** validate lengths before calling `crypto_sign_ed25519_pk_to_curve25519`.
    - Lets libsodium’s internal error bubble up.

Updating the frontend build to the current code will at least turn this into a clearer message about which key is wrong.

***

## How to confirm and fix it

### 1. Check key lengths in Postgres

Run these against your production DB:

```sql
-- Identity keys
SELECT username, octet_length(public_key)
FROM users;

-- Signed prekeys
SELECT u.username, octet_length(sp.public_key) AS sp_len
FROM signed_prekeys sp
JOIN users u ON sp.user_id = u.id;

-- One-time prekeys
SELECT u.username, octet_length(ot.public_key) AS ot_len
FROM one_time_prekeys ot
JOIN users u ON ot.user_id = u.id;
```

Every length should be **32**. Any rows with a different length are exactly the accounts that will cause “invalid edPk length” when you try to chat with them.

### 2. Clean or migrate bad rows

For any user where lengths are wrong, you have essentially three options:

- **Easiest (dev/test environment):**
Delete the user and all their prekeys, then re‑register via the current frontend so the server stores fresh 32‑byte keys.
- **Production but low‑impact:**
Force re‑registration of those users (ask them to sign out, clear account, and sign up again) and delete their old key rows.
- **Full migration (if you know the old format):**
If you know you previously stored base64/hex, write a one‑off migration that decodes the old string into 32 bytes and updates `public_key`, `signed_prekeys.public_key`, and `one_time_prekeys.public_key` accordingly.


### 3. Redeploy the current frontend

Make sure ghen-app.my.id is built from the latest `ghenapp-web`:

- The build that is live should include `decodePubKey` and the improved error messages in `session.ts`.
- Rebuild (`npm run build` / Vite) and redeploy so new DMs show explicit diagnostics like
`"\"alice\" identity key: expected 32 bytes but got 64..."` instead of the generic edPk error.

***

## TL;DR

When you start a new chat, the client fetches the other user’s prekey bundle and runs X3DH; libsodium throws “invalid edPk length” because **at least one of that user’s Ed25519 public keys (identity/signed/onetime) is not exactly 32 bytes long in the database**.

Check `octet_length(public_key)` for users/prekeys in Postgres, fix any rows that aren’t 32 bytes (ideally by re‑registering those users), and redeploy the current frontend so future issues are caught with clearer error messages.
<span style="display:none">[^1]</span>

<div align="center">⁂</div>

[^1]: Screenshot_2026-05-06-16-42-42-70_40deb401b9ffe8e1df2f1cc5ba480b12.jpg

