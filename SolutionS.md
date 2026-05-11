For Bug #2 — Client snowflake ID vs server ID mismatch in cache
S-1. After the server ACKs the message (WebSocket markDelivered or HTTP response), re-key the cache from client-snowflake to server-assigned ID.

S-2. Add a server endpoint POST /messages that returns the server-assigned ID synchronously, then use that ID for both addMessage and cacheDecrypted before WS send.

S-3. Store plaintext cache entries under content hash (e.g. sha256(payload)) instead of any ID, so client and server ID mismatches don't matter.

S-4. Use pessimistic cache: only call getCachedDecrypted for messages older than 1 minute (recent messages are always in-memory from the store, not from the reload path).

For Bug #3 — Receiver never gets 0x02 frame / ephemeral data deleted prematurely
S-5. Don't delete ephemeral data on first send. Delete it only after receiving server ACK that the receiver has processed the handshake (requires a handshake-ack WS message type in the protocol).

S-6. Separate the X3DH handshake from the first chat message. Before any message is sent, exchange a dedicated HANDSHAKE frame (0x02 only, no payload) via WS, wait for receiver to process it, then proceed with 0x01 messages.

S-7. Re-attach ephemeral header on every message until the receiver confirms session. Keep ephemeral data in IndexedDB until the peer echoes back any 0x01 frame (meaning they successfully ran acceptSession). Track a per-conversation handshakeConfirmed flag.

S-8. Move X3DH handshake to a REST call, not piggybacked on the first WS message. Receiver fetches the handshake bundle via GET /api/v1/conversations/:id/handshake and processes it before any messages arrive over WS.

S-9. Guard encryptOutbound: if ephemeral data is missing but session was initiated (i.e., not yet confirmed), call initiateSession(forceReset=true) to regenerate the ephemeral data.

For Bug #4 — SPK private key fallback to identity key
S-10. Hard-fail instead of fallback: if loadPrivateKey('spk:${myUsername}') returns null, throw an error that surfaces to the user ("Keys missing — re-register this device"), instead of silently using the wrong key.

S-11. Store SPK private key redundantly: during registration/key upload, also store the SPK priv under a secondary key (e.g., spk-latest:${myUsername}) and look it up by both names.

S-12. Derive SPK from identity key deterministically (HKDF-based), so it can always be reconstructed — eliminating the "missing SPK priv" condition entirely.

For the overall initRatchet symmetric chain key concern
S-13. Use a proper asymmetric ratchet: after X3DH produces the master secret, do a Diffie-Hellman ratchet step between the initiator's ratchet key pair and the responder's identity key, so each side has a unique asymmetric root before deriving chain keys. This is the Signal protocol's correct approach.

S-14. Fix chain key derivation labels to include a side identifier: 'GhenApp-DR-initiator-send' / 'GhenApp-DR-responder-send' so even without a swap, both sides derive unique chain keys. This is a simpler fix that avoids the swap-based approach.

S-15. Keep current swap approach but add a regression test: write a unit test that runs initiateSession + acceptSession + one encrypt + one decrypt and asserts plaintext === original before deploying any further changes.

For the overall architecture (longer-term)
S-16. Add a crypto layer integration test in the browser (/debug/crypto-selftest): on page load, run a full local initiator + responder session round-trip in-memory and display pass/fail. This would have caught every one of the above bugs immediately.

S-17. Flush IndexedDB and force re-registration: since old IndexedDB data from broken sessions will continue to poison new attempts, add a /_debug/clear-idb dev button that nukes all stores, forcing fresh key generation on next visit.

S-18. Add structured error logging for decryptInbound: instead of console.error and return null, return a typed error code so the UI can show a specific reason ("missing session", "bad keys", "decrypt failed") rather than the generic 🔒 placeholder.