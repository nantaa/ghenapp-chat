// Client-side crypto module — Ed25519 keypair generation + key storage
// Uses libsodium-wrappers. Private keys stored AES-256-GCM encrypted in IndexedDB.
import _sodium from 'libsodium-wrappers-sumo'
import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'ghenapp-crypto'
const DB_VERSION = 2
const STORE_NAME = 'keys'

// ─── Database ─────────────────────────────────────────────────────────────────

async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    },
  })
}

// ─── Sodium init ──────────────────────────────────────────────────────────────

let _ready = false
async function sodium() {
  if (!_ready) { await _sodium.ready; _ready = true }
  return _sodium
}

// ─── KeyPair Generation ───────────────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: Uint8Array   // 32 bytes
  privateKey: Uint8Array  // 64 bytes (seed + public)
}

export async function generateIdentityKeyPair(): Promise<Ed25519KeyPair> {
  const na = await sodium()
  const kp = na.crypto_sign_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

// ─── X25519 helpers ───────────────────────────────────────────────────────────

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export async function ed25519ToX25519(ed25519Priv: Uint8Array): Promise<X25519KeyPair> {
  const na = await sodium()
  const x25519Priv = na.crypto_sign_ed25519_sk_to_curve25519(ed25519Priv)
  const x25519Pub = na.crypto_scalarmult_base(x25519Priv)
  return { publicKey: x25519Pub, privateKey: x25519Priv }
}

export async function generateX25519(): Promise<X25519KeyPair> {
  const na = await sodium()
  const kp = na.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export async function signChallenge(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  const na = await sodium()
  return na.crypto_sign_detached(message, privateKey)
}

export function buildLoginMessage(username: string): Uint8Array {
  const minuteTs = Math.floor(Date.now() / 1000 / 60) * 60
  return new TextEncoder().encode(`ghenapp-login:${username}:${minuteTs}`)
}

// ─── Prekey Generation ────────────────────────────────────────────────────────

export async function generateSignedPrekey(identityPrivKey: Uint8Array): Promise<{
  publicKey: Uint8Array; signature: Uint8Array; privateKey: Uint8Array
}> {
  const na = await sodium()
  const kp = na.crypto_box_keypair()
  const signature = na.crypto_sign_detached(kp.publicKey, identityPrivKey)
  return { publicKey: kp.publicKey, signature, privateKey: kp.privateKey }
}

export async function generateOnetimePrekeys(count: number): Promise<{
  publicKeys: Uint8Array[]; privateKeys: Uint8Array[]
}> {
  const na = await sodium()
  const pairs = Array.from({ length: count }, () => na.crypto_box_keypair())
  return { publicKeys: pairs.map((p) => p.publicKey), privateKeys: pairs.map((p) => p.privateKey) }
}

// ─── BIP-39 Mnemonic ──────────────────────────────────────────────────────────
// Full 2048-word BIP-39 English wordlist (split across 8 lines for readability)

const BIP39: string[] = ('abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby balance bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone book boost border boring borrow boss bottom bounce box boy bracket brain brand brave breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp canal cancel candy cannon canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact endless endorse enemy engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip erase erase erosion escape essay estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude exercise exhaust exhibit exile exist exit exotic expand expire explain expose express extend extra eye fable face faculty fade faint faith fall false fame family famous fan fancy fantasy far fashion fat fatal father fatigue fault favorite feature february federal fee feed feel feet fellow felt fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grasp grass gravity great green grid grief grit grocery group grow grunt guard guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn hospital host hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon ignore ill illegal image imitate immense immune impact impose improve impulse inbox income increase index indicate indoor industry infant inflict inform inhale inherit initial inject inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kingdom kit kitchen kite kitten kiwi knee knife knock know lab ladder lady lake lamp language laptop large later laugh laundry lava law lawn lawsuit layer lazy leader learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics mad main mammal mango mansion manual maple marble march margin marine market marriage mask master match material math matrix matter maximum maze meadow mean medal media melody melt member memory mention mentor menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle miss mixed mixture mobile model modify mom monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery naive name napkin narrow nasty natural nature near neck need negative neglect neither nephew nerve nest network neutral never news next nice night noble noise nominee noodle normal north notable note nothing notice novel now nuclear nurse nut oak obey object oblige obscure obtain ocean october odor off often oil okay old olive olympic omit once onion open option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outside oval over own oyster ozone paddle page pair palace palm panda panic panther paper parade parent park parrot party pass patch path patrol pause pave payment peace peanut peasant pelican pen penalty pending pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play plot pluck plug plunge poem poet point polar pole police pond pony popular portion position possible post potato poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punish pupil purchase purity purpose push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rage rail rain raise rally ramp ranch random range rapid rare rate rather raven reach ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm ribbon rice rich ride rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling siege sight sign silent silk silly silver similar simple since sing siren sister situate six size ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock solar soldier solid solution solve someone song soon sorry soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stop store storm story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise sustain swallow swamp swap swear sweet swift swim swing switch sword symbol symptom syrup table tackle tag tail talent tamper tank tape target task tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tilt timber time tiny tip tired title toast tobacco today together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck truly trumpet trust truth tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel wedding weekend weird welcome west wet whale wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo').split(' ')

export async function deriveMnemonic(privateKey: Uint8Array): Promise<string[]> {
  const na = await sodium()
  const hash = na.crypto_generichash(24, privateKey, null)
  const words: string[] = []
  for (let i = 0; i < 12; i++) {
    const hi = hash[i * 2] ?? 0
    const lo = hash[i * 2 + 1] ?? 0
    const idx = ((hi * 256 + lo) >>> 0) % BIP39.length
    words.push(BIP39[idx])
  }
  return words
}

/** Reverse lookup: find the private key whose mnemonic matches the given words. */
export async function mnemonicToPrivKey(
  _words: string[],
  _username: string,
): Promise<Uint8Array | null> {
  // Recovery requires the user to also supply their passphrase; the raw private
  // key bytes are derived through re-registration. This stub returns null so
  // RecoveryPage can guide the user to re-register with the same key material.
  // Full deterministic recovery (BIP-32 HKDF) is a Wave 4 item.
  return null
}

// ─── AES-256-GCM passphrase encryption (Wave 1A) ─────────────────────────────

const PBKDF2_ITERS = 100_000
const SALT_BYTES = 16
const IV_BYTES = 12

interface EncryptedBlob {
  v: 1
  salt: number[]
  iv: number[]
  ct: number[]
}

async function deriveAESKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptKey(passphrase: string, rawKey: Uint8Array): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv   = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const aesKey = await deriveAESKey(passphrase, salt)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, rawKey)
  return { v: 1, salt: Array.from(salt), iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) }
}

async function decryptKey(passphrase: string, blob: EncryptedBlob): Promise<Uint8Array> {
  const salt = new Uint8Array(blob.salt)
  const iv   = new Uint8Array(blob.iv)
  const ct   = new Uint8Array(blob.ct)
  const aesKey = await deriveAESKey(passphrase, salt)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct)
  return new Uint8Array(pt)
}

// ─── Encrypted IndexedDB Key Storage ─────────────────────────────────────────

export async function storePrivateKey(
  username: string,
  privateKey: Uint8Array,
  passphrase?: string,
): Promise<void> {
  const db = await getDB()
  if (passphrase) {
    const blob = await encryptKey(passphrase, privateKey)
    await db.put(STORE_NAME, blob, `identity:${username}`)
  } else {
    await db.put(STORE_NAME, privateKey, `identity:${username}`)
  }
}

export async function loadPrivateKey(
  username: string,
  passphrase?: string,
): Promise<Uint8Array | null> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  if (!val) return null
  // Detect encrypted blob (has .v === 1)
  if (val && typeof val === 'object' && (val as any).v === 1) {
    if (!passphrase) throw new Error('Passphrase required to unlock this key.')
    try {
      return await decryptKey(passphrase, val as EncryptedBlob)
    } catch {
      throw new Error('Wrong passphrase — decryption failed.')
    }
  }
  return val instanceof Uint8Array ? val : new Uint8Array(val as any)
}

export async function isKeyEncrypted(username: string): Promise<boolean> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  return val != null && typeof val === 'object' && (val as any).v === 1
}

export async function deletePrivateKey(username: string): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_NAME, `identity:${username}`)
}

export async function hasStoredKey(username: string): Promise<boolean> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, `identity:${username}`)
  return val != null
}

// ─── Sub-key storage (SPK, OPK) — always raw ─────────────────────────────────
// Only the identity key is passphrase-protected. Sub-keys use their own namespace.

export async function storeSubKey(label: string, key: Uint8Array): Promise<void> {
  const db = await getDB()
  await db.put(STORE_NAME, key, label)
}

export async function loadSubKey(label: string): Promise<Uint8Array | null> {
  const db = await getDB()
  const val = await db.get(STORE_NAME, label)
  return val ? new Uint8Array(val as any) : null
}

// ─── TOFU — Trust On First Use (Wave 1C) ─────────────────────────────────────

const TOFU_PREFIX = 'tofu:'

export async function storeTrustedKey(username: string, pubKeyHex: string): Promise<void> {
  const db = await getDB()
  await db.put(STORE_NAME, pubKeyHex, TOFU_PREFIX + username)
}

export async function loadTrustedKey(username: string): Promise<string | null> {
  const db = await getDB()
  return (await db.get(STORE_NAME, TOFU_PREFIX + username)) ?? null
}

export async function checkKeyChange(
  username: string,
  newPubKeyHex: string,
): Promise<'new' | 'same' | 'changed'> {
  const trusted = await loadTrustedKey(username)
  if (!trusted) return 'new'
  return trusted === newPubKeyHex ? 'same' : 'changed'
}
