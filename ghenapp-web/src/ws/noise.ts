// Client-side Noise_XX_25519_ChaChaPoly_SHA256 implementation
// Mirrors the Go server implementation exactly — both must produce the same
// DH values and cipher state to establish a shared session.
//
// Handshake flow (initiator = client):
//   1. Client fetches server's static pubkey from /api/v1/noise/pubkey
//   2. Client generates ephemeral key pair
//   3. Client → Server: msg1 = [e] (32 bytes)
//   4. Server → Client: msg2 = [e, ee, enc_s, es] (80 bytes)
//   5. Client → Server: msg3 = [enc_s, se] (48 bytes)
//   6. Both sides split → sendKey + recvKey (ChaCha20-Poly1305)

import _sodium from 'libsodium-wrappers-sumo'

// ─── Init ─────────────────────────────────────────────────────────────────────

let _ready = false
async function na() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NoiseKeyPair {
  publicKey: Uint8Array   // 32 bytes X25519
  privateKey: Uint8Array  // 32 bytes X25519
}

export interface NoiseTransportKeys {
  sendKey: Uint8Array  // 32 bytes — used to encrypt outbound frames
  recvKey: Uint8Array  // 32 bytes — used to decrypt inbound frames
}

// ─── Protocol constants ───────────────────────────────────────────────────────

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256'
const DH_LEN = 32
const TAG_LEN = 16
const NONCE_LEN = 12

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function generateX25519(): Promise<NoiseKeyPair> {
  const s = await na()
  const kp = s.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

async function dh(priv: Uint8Array, pub: Uint8Array): Promise<Uint8Array> {
  const s = await na()
  return s.crypto_scalarmult(priv, pub)
}

function sha256(data: Uint8Array): Uint8Array {
  // libsodium's crypto_hash_sha256
  return _sodium.crypto_hash_sha256(data)
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return _sodium.crypto_auth_hmacsha256(data, key)
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  // Extract
  const tempKey = hmacSha256(ck, ikm)
  // Expand
  const out1 = hmacSha256(tempKey, new Uint8Array([0x01]))
  const out2In = new Uint8Array([...out1, 0x02])
  const out2 = hmacSha256(tempKey, out2In)
  return [out1, out2]
}

function buildNonce(n: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_LEN)
  const view = new DataView(nonce.buffer)
  view.setUint32(4, n >>> 0, true)         // low 32 bits, little-endian
  view.setUint32(8, Math.floor(n / 2 ** 32), true) // high 32 bits
  return nonce
}

async function chachaPoly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const s = await na()
  return s.crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key)
}

async function chachaPoly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const s = await na()
  const pt = s.crypto_aead_chacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key)
  if (!pt) throw new Error('noise: AEAD decryption failed')
  return pt
}

// ─── Symmetric State ──────────────────────────────────────────────────────────

class SymmetricState {
  ck: Uint8Array  // chaining key
  h: Uint8Array   // handshake hash
  k: Uint8Array   // cipher key (empty = no key yet)
  n: number       // nonce counter

  constructor() {
    // h = SHA256(protocol_name) or protocol_name padded to 32 bytes
    const name = new TextEncoder().encode(PROTOCOL_NAME)
    if (name.length <= 32) {
      const padded = new Uint8Array(32)
      padded.set(name)
      this.h = padded
    } else {
      this.h = sha256(name)
    }
    this.ck = new Uint8Array(this.h)
    this.k = new Uint8Array(0)
    this.n = 0
  }

  mixHash(data: Uint8Array) {
    const combined = new Uint8Array([...this.h, ...data])
    this.h = sha256(combined)
  }

  mixKey(dhOutput: Uint8Array) {
    const [ck, k] = hkdf2(this.ck, dhOutput)
    this.ck = ck
    this.k = k
    this.n = 0
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.k.length === 0) {
      this.mixHash(plaintext)
      return plaintext
    }
    const nonce = buildNonce(this.n++)
    const ct = await chachaPoly1305Encrypt(this.k, nonce, plaintext, this.h)
    this.mixHash(ct)
    return ct
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (this.k.length === 0) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const nonce = buildNonce(this.n++)
    const pt = await chachaPoly1305Decrypt(this.k, nonce, ciphertext, this.h)
    this.mixHash(ciphertext)
    return pt
  }

  split(): [Uint8Array, Uint8Array] {
    return hkdf2(this.ck, new Uint8Array(32))
  }
}

// ─── Noise_XX Initiator Handshake ─────────────────────────────────────────────

export class NoiseHandshakeInitiator {
  private ss: SymmetricState
  private localStatic: NoiseKeyPair
  private localEphem: NoiseKeyPair | null = null
  private remoteEphem: Uint8Array | null = null
  private remoteStatic: Uint8Array | null = null
  private _sendKey: Uint8Array | null = null
  private _recvKey: Uint8Array | null = null
  done = false

  constructor(localStatic: NoiseKeyPair, _serverStaticPub: Uint8Array) {
    this.ss = new SymmetricState()
    this.localStatic = localStatic
    this.ss.mixHash(new Uint8Array(0)) // empty prologue
  }

  /** Generate ephemeral key and build msg1: [e] */
  async buildMsg1(): Promise<Uint8Array> {
    this.localEphem = await generateX25519()
    this.ss.mixHash(this.localEphem.publicKey)
    return new Uint8Array(this.localEphem.publicKey)
  }

  /** Process server msg2: [e, ee, enc_s, es] */
  async readMsg2(msg: Uint8Array): Promise<void> {
    if (msg.length < DH_LEN + DH_LEN + TAG_LEN) throw new Error('noise: msg2 too short')
    if (!this.localEphem) throw new Error('noise: msg1 not sent yet')

    // e: server's ephemeral pubkey
    this.remoteEphem = msg.slice(0, DH_LEN)
    this.ss.mixHash(this.remoteEphem)

    // ee: DH(localEphem, remoteEphem)
    const ee = await dh(this.localEphem.privateKey, this.remoteEphem)
    this.ss.mixKey(ee)

    // s: decrypt server's static pubkey
    const encS = msg.slice(DH_LEN, DH_LEN + DH_LEN + TAG_LEN)
    const serverStaticPt = await this.ss.decryptAndHash(encS)
    this.remoteStatic = serverStaticPt

    // es: DH(localEphem, remoteStatic)
    const es = await dh(this.localEphem.privateKey, this.remoteStatic)
    this.ss.mixKey(es)
  }

  /** Build msg3: [enc_s, se] and finalise keys */
  async buildMsg3(): Promise<Uint8Array> {
    if (!this.localEphem || !this.remoteEphem) throw new Error('noise: msg2 not read yet')

    // s: encrypt client's static pubkey
    const encS = await this.ss.encryptAndHash(this.localStatic.publicKey)

    // se: DH(localStatic, remoteEphem)
    const se = await dh(this.localStatic.privateKey, this.remoteEphem)
    this.ss.mixKey(se)

    // const [sendKey, recvKey] = this.ss.split()
    // this._sendKey = sendKey
    // this._recvKey = recvKey

    // AFTER (correct — client flips the keys relative to server):
    const [k1, k2] = this.ss.split()
    this._sendKey = k2   // client sends with k2 (server receives with k2 = server's recvKey)
    this._recvKey = k1   // client receives with k1 (server sends with k1 = server's sendKey)

    this.done = true
    return encS
  }

  get transportKeys(): NoiseTransportKeys {
    if (!this.done || !this._sendKey || !this._recvKey) throw new Error('noise: handshake not complete')
    return { sendKey: this._sendKey, recvKey: this._recvKey }
  }
}

// ─── Transport Cipher ─────────────────────────────────────────────────────────

export class NoiseTransportCipher {
  private key: Uint8Array
  private n: number = 0

  constructor(key: Uint8Array) {
    this.key = key
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = buildNonce(this.n++)
    return chachaPoly1305Encrypt(this.key, nonce, plaintext, new Uint8Array(0))
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const nonce = buildNonce(this.n++)
    return chachaPoly1305Decrypt(this.key, nonce, ciphertext, new Uint8Array(0))
  }
}

// ─── Noise WebSocket Channel ──────────────────────────────────────────────────

const NOISE_LEN_PREFIX = 4  // 4-byte big-endian length prefix matching server

/**
 * NoiseChannel wraps a WebSocket and performs the Noise_XX handshake,
 * then provides encrypted send/receive for IMCP frames.
 */
export class NoiseChannel {
  private ws: WebSocket
  private encoder: NoiseTransportCipher | null = null
  private decoder: NoiseTransportCipher | null = null
  private _handshakeDone = false

  constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.binaryType = 'arraybuffer'
  }

  /** Perform Noise_XX handshake with the server */
  async performHandshake(
    clientStatic: NoiseKeyPair,
    serverStaticPub: Uint8Array,
    onMessage?: (data: ArrayBuffer) => void
  ): Promise<void> {
    const hs = new NoiseHandshakeInitiator(clientStatic, serverStaticPub)

    // Msg1: [e]
    const msg1 = await hs.buildMsg1()
    this.ws.send(msg1.buffer.slice(msg1.byteOffset, msg1.byteOffset + msg1.byteLength) as ArrayBuffer)

    // Wait for msg2
    const msg2 = await this._waitMessage()
    await hs.readMsg2(new Uint8Array(msg2))

    // Msg3: [enc_s, se]
    const msg3 = await hs.buildMsg3()
    this.ws.send(msg3.buffer.slice(msg3.byteOffset, msg3.byteOffset + msg3.byteLength) as ArrayBuffer)

    const { sendKey, recvKey } = hs.transportKeys
    this.encoder = new NoiseTransportCipher(sendKey)
    this.decoder = new NoiseTransportCipher(recvKey)
    this._handshakeDone = true

    if (onMessage) this.onMessage(onMessage)
  }

  /** Register the frame handler (called after handshake) */
  onMessage(handler: (data: ArrayBuffer) => void) {
    this.ws.onmessage = async (ev: MessageEvent<ArrayBuffer>) => {
      if (!this.decoder) return
      const raw = new Uint8Array(ev.data)
      if (raw.length < NOISE_LEN_PREFIX + TAG_LEN) return
      const payload = raw.slice(NOISE_LEN_PREFIX)
      try {
        const plaintext = await this.decoder.decrypt(payload)
        handler(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer)
      } catch (err) {
        console.error('Noise transport decryption failed (tampered or out-of-order):', err)
      }
    }
  }

  /** Send an encrypted IMCP frame */
  async send(plaintext: Uint8Array): Promise<void> {
    if (!this.encoder) throw new Error('noise: handshake not complete')
    const ct = await this.encoder.encrypt(plaintext)
    // Prepend 4-byte length prefix matching server's wire format
    const wire = new Uint8Array(NOISE_LEN_PREFIX + ct.length)
    const view = new DataView(wire.buffer)
    view.setUint32(0, ct.length, false) // big-endian
    wire.set(ct, NOISE_LEN_PREFIX)
    this.ws.send(wire)
  }

  get handshakeDone() { return this._handshakeDone }

  private _waitMessage(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('noise: handshake timeout')), 10_000)
      const handler = (ev: MessageEvent<ArrayBuffer>) => {
        clearTimeout(timeout)
        this.ws.removeEventListener('message', handler)
        resolve(ev.data)
      }
      this.ws.addEventListener('message', handler)
    })
  }
}
