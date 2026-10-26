/**
 * App-lock secrets.
 *
 * The PIN or password itself is never stored. What is stored is a random salt
 * and a PBKDF2-SHA-256 digest, so a copy of the IndexedDB database (or a backup
 * file) does not reveal the secret. Verification re-derives the digest and
 * compares it in constant time.
 *
 * This is a screen lock, not encryption. It keeps a customer or a curious
 * cashier out of the app; it does not make the underlying records private to
 * someone with developer tools and the unlocked device. Genuine encryption
 * would have to wrap every record, which breaks barcode indexes, stock sums and
 * the reports built on them.
 *
 * Kept free of Dexie and React imports so the pure rules can be tested in Node.
 */

export type SecretKind = 'pin' | 'password'

export const PIN_MIN = 4
export const PIN_MAX = 8
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 600,000. A till is often a
 * cheap phone, and the gate is only a deterrent, so 310,000 keeps unlock under
 * about half a second there while still making a dumped hash expensive to
 * grind. The count travels with the credential, so it can be raised later
 * without invalidating existing locks.
 */
export const PBKDF2_ITERATIONS = 310_000

export interface StoredCredential {
  v: 1
  kind: SecretKind
  /** PIN length so the keypad knows when to submit. Not a secret. */
  length: number
  algorithm: 'PBKDF2-SHA-256'
  iterations: number
  /** Base64, 16 random bytes. */
  salt: string
  /** Base64, 32 derived bytes. */
  hash: string
}

/** `null` when the value is acceptable, otherwise a sentence for the user. */
export function validateSecret(kind: SecretKind, value: string): string | null {
  if (kind === 'pin') {
    if (!/^\d+$/.test(value)) return 'Use digits only'
    if (value.length < PIN_MIN) return `Use at least ${PIN_MIN} digits`
    if (value.length > PIN_MAX) return `Use at most ${PIN_MAX} digits`
    return null
  }
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`
  if (value.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`
  if (value.trim() !== value) return 'Do not start or end with a space'
  return null
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** WebAuthn hands credential ids back as bytes but they travel as base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  return base64ToBytes(base64 + padding)
}

/** Raw PBKDF2 output. Exported so the test suite can exercise it directly. */
export async function hashSecret(
  secret: string,
  salt: BufferSource,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    256,
  )
  return new Uint8Array(bits)
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Build a fresh credential. The plain secret is not part of the result. */
export async function createCredential(
  kind: SecretKind,
  secret: string,
): Promise<StoredCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = await hashSecret(secret, salt)
  return {
    v: 1,
    kind,
    length: secret.length,
    algorithm: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(digest),
  }
}

export async function verifySecret(
  credential: StoredCredential,
  secret: string,
): Promise<boolean> {
  try {
    const digest = await hashSecret(
      secret,
      base64ToBytes(credential.salt),
      credential.iterations,
    )
    return equalBytes(digest, base64ToBytes(credential.hash))
  } catch {
    // A damaged credential must read as "wrong secret", never as an unlock.
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Failed-attempt brake
 *
 * Kept in localStorage rather than IndexedDB so it survives a reload and is
 * readable synchronously while the lock screen is mounting. It does not need
 * to be tamper-proof: anyone who can edit it can also clear the site data,
 * which removes the lock altogether.
 * ------------------------------------------------------------------ */

export interface AttemptState {
  fails: number
  /** Epoch ms until which entry is refused. 0 when not cooling down. */
  until: number
  /** Epoch ms of the most recent failure, used to expire old streaks. */
  last: number
}

export const ATTEMPT_KEY = 'till.lock.attempts'
export const FREE_ATTEMPTS = 5
const SHORT_COOLDOWN_MS = 30_000
const LONG_COOLDOWN_MS = 5 * 60_000
/** A failure streak older than this is forgotten rather than escalating. */
const FORGET_AFTER_MS = 60 * 60_000

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const EMPTY_ATTEMPTS: AttemptState = { fails: 0, until: 0, last: 0 }

/**
 * Attempt streaks are per staff account. The owner and each cashier therefore
 * earn their own cooldown, and a cashier cannot lock the owner out by guessing
 * on their own name. The legacy key is kept as the default so older test/admin
 * paths still work.
 */
export function attemptKey(accountId: string): string {
  return `${ATTEMPT_KEY}.${accountId}`
}

export function readAttempts(
  store: KeyValueStore = localStorage,
  key = ATTEMPT_KEY,
): AttemptState {
  try {
    const raw = store.getItem(key)
    if (!raw) return { ...EMPTY_ATTEMPTS }
    const parsed = JSON.parse(raw) as Partial<AttemptState>
    return {
      fails: Number(parsed.fails) || 0,
      until: Number(parsed.until) || 0,
      last: Number(parsed.last) || 0,
    }
  } catch {
    return { ...EMPTY_ATTEMPTS }
  }
}

/** How long a given number of consecutive failures earns. */
export function failureDelayMs(fails: number): number {
  if (fails < FREE_ATTEMPTS) return 0
  return fails >= FREE_ATTEMPTS * 2 ? LONG_COOLDOWN_MS : SHORT_COOLDOWN_MS
}

export function recordFailure(
  store: KeyValueStore = localStorage,
  now = Date.now(),
  key = ATTEMPT_KEY,
): AttemptState {
  const previous = readAttempts(store, key)
  const stale = now - previous.last > FORGET_AFTER_MS
  const fails = (stale ? 0 : previous.fails) + 1
  const delay = failureDelayMs(fails)
  const state: AttemptState = {
    fails,
    until: delay > 0 ? now + delay : 0,
    last: now,
  }
  try {
    store.setItem(key, JSON.stringify(state))
  } catch {
    // Private-mode quota failures must not stop the lock screen working.
  }
  return state
}

export function clearAttempts(
  store: KeyValueStore = localStorage,
  key = ATTEMPT_KEY,
): void {
  try {
    store.removeItem(key)
  } catch {
    // Ignore; a fresh attempt streak is not worth crashing over.
  }
}

export function cooldownRemaining(state: AttemptState, now = Date.now()): number {
  return Math.max(0, state.until - now)
}
