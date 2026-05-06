test-delta@TestDelta:/opt/ghenapp/repo/ghenapp-web$ npm run build

> ghenapp-web@0.0.0 build
> tsc -b && vite build

src/crypto/keygen.ts:64:52 - error TS2339: Property 'secretKey' does not exist on type '{ publicKey: Uint8Array<ArrayBufferLike>; privateKey: Uint8Array<ArrayBufferLike>; keyType: string; }'.

64   return { publicKey: kp.publicKey, privateKey: kp.secretKey }
                                                      ~~~~~~~~~

src/crypto/keygen.ts:123:19 - error TS2554: Expected 3-4 arguments, but got 2.

123   const hash = na.crypto_generichash(16, privateKey)
                      ~~~~~~~~~~~~~~~~~~

  node_modules/libsodium-wrappers/dist/modules-esm/libsodium-wrappers.d.mts:1189:87
    1189 export function crypto_generichash(hash_length: number, message: Uint8Array | string, key: Uint8Array | string | null, outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
                                                                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    An argument for 'key' was not provided.

src/crypto/ratchet.ts:142:9 - error TS6133: 's' is declared but its value is never read.

142   const s = await na()
            ~

src/crypto/session.ts:15:8 - error TS6133: 'RatchetState' is declared but its value is never read.

15   type RatchetState,
          ~~~~~~~~~~~~

src/crypto/session.ts:16:8 - error TS6133: 'EncryptedMessage' is declared but its value is never read.

16   type EncryptedMessage,
          ~~~~~~~~~~~~~~~~

src/crypto/session.ts:18:26 - error TS6133: 'generateX25519' is declared but its value is never read.

18 import { loadPrivateKey, generateX25519, ed25519ToX25519 } from './keygen'
                            ~~~~~~~~~~~~~~

src/crypto/session.ts:18:42 - error TS6133: 'ed25519ToX25519' is declared but its value is never read.

18 import { loadPrivateKey, generateX25519, ed25519ToX25519 } from './keygen'
                                            ~~~~~~~~~~~~~~~

src/crypto/session.ts:77:3 - error TS6133: 'usedOnetimePrekey' is declared but its value is never read.

77   usedOnetimePrekey: boolean,
     ~~~~~~~~~~~~~~~~~

src/lib/api.ts:6:15 - error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.

6   constructor(public status: number, message: string) {
                ~~~~~~~~~~~~~~~~~~~~~

src/pages/RegisterPage.tsx:2:18 - error TS6133: 'Eye' is declared but its value is never read.

2 import { Shield, Eye, EyeOff, Loader2, Copy, CheckCheck } from 'lucide-react'
                   ~~~

src/pages/RegisterPage.tsx:2:23 - error TS6133: 'EyeOff' is declared but its value is never read.

2 import { Shield, Eye, EyeOff, Loader2, Copy, CheckCheck } from 'lucide-react'
                        ~~~~~~

src/push/push.ts:77:7 - error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'string | BufferSource | null | undefined'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
          Types of property '[Symbol.toStringTag]' are incompatible.
            Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.

77       applicationServerKey: urlBase64ToUint8Array(vapidKey),
         ~~~~~~~~~~~~~~~~~~~~

src/ws/client.ts:198:20 - error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'string | BufferSource | Blob'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
          Types of property '[Symbol.toStringTag]' are incompatible.
            Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.

198       this.ws.send(frame)
                       ~~~~~

src/ws/noise.ts:47:52 - error TS2339: Property 'secretKey' does not exist on type '{ publicKey: Uint8Array<ArrayBufferLike>; privateKey: Uint8Array<ArrayBufferLike>; keyType: string; }'.

47   return { publicKey: kp.publicKey, privateKey: kp.secretKey }
                                                      ~~~~~~~~~

src/ws/noise.ts:174:11 - error TS6133: 'serverStaticPub' is declared but its value is never read.

174   private serverStaticPub: Uint8Array
              ~~~~~~~~~~~~~~~

src/ws/noise.ts:273:11 - error TS6133: 'onFrame' is declared but its value is never read.

273   private onFrame: ((data: ArrayBuffer) => void) | null = null
              ~~~~~~~

src/ws/noise.ts:290:18 - error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'string | BufferSource | Blob'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
          Types of property '[Symbol.toStringTag]' are incompatible.
            Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.

290     this.ws.send(msg1)
                     ~~~~

src/ws/noise.ts:298:18 - error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'string | BufferSource | Blob'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
          Types of property '[Symbol.toStringTag]' are incompatible.
            Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.

298     this.ws.send(msg3)
                     ~~~~

src/ws/noise.ts:316:17 - error TS2345: Argument of type 'ArrayBufferLike' is not assignable to parameter of type 'ArrayBuffer'.
  Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
    Types of property '[Symbol.toStringTag]' are incompatible.
      Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.

316         handler(plaintext.buffer)
                    ~~~~~~~~~~~~~~~~


Found 19 errors.