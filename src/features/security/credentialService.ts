import { getSetting, setSetting } from '@/db'
import {
  createCredential,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PIN_MAX,
  PIN_MIN,
  type SecretKind,
  type StoredCredential,
} from './secret'

/**
 * Where the app lock lives.
 *
 * Settings rows are used rather than a new Dexie table: the credential is a
 * single value, and the existing helpers already carry sync metadata. These
 * keys are deliberately never queued to the outbox, so the digest never leaves
 * the device.
 *
 * An empty string means "not configured", matching how sync.config is turned
 * off. Any malformed value is treated the same way: a damaged setting must not
 * leave the till impossible to open.
 */

const CREDENTIAL_KEY = 'security.credential'
const BIOMETRIC_KEY = 'security.biometric'

export interface BiometricRecord {
  v: 1
  /** Base64url of the credential id WebAuthn returned at enrolment. */
  credentialId: string
  /** Base64 opaque user handle, so a future re-enrolment can reuse it. */
  userHandle: string
  createdAt: number
}

/** Validate a credential object that was nested inside another setting. */
export function parseCredentialValue(value: unknown): StoredCredential | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StoredCredential>
  const validLength =
    candidate.kind === 'pin'
      ? typeof candidate.length === 'number' &&
        candidate.length >= PIN_MIN &&
        candidate.length <= PIN_MAX
      : typeof candidate.length === 'number' &&
        candidate.length >= PASSWORD_MIN &&
        candidate.length <= PASSWORD_MAX
  const valid =
    candidate.v === 1 &&
    (candidate.kind === 'pin' || candidate.kind === 'password') &&
    validLength &&
    candidate.algorithm === 'PBKDF2-SHA-256' &&
    typeof candidate.iterations === 'number' &&
    candidate.iterations >= 5_000 &&
    candidate.iterations <= 2_000_000 &&
    typeof candidate.salt === 'string' &&
    candidate.salt.length > 0 &&
    typeof candidate.hash === 'string' &&
    candidate.hash.length > 0
  return valid ? (candidate as StoredCredential) : null
}

function parseStoredCredential(raw: string | null): StoredCredential | null {
  if (!raw) return null
  try {
    return parseCredentialValue(JSON.parse(raw))
  } catch {
    return null
  }
}

function parseBiometric(raw: string | null): BiometricRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<BiometricRecord>
    const valid =
      value.v === 1 &&
      typeof value.credentialId === 'string' &&
      value.credentialId.length > 0 &&
      typeof value.userHandle === 'string' &&
      typeof value.createdAt === 'number'
    return valid ? (value as BiometricRecord) : null
  } catch {
    return null
  }
}

export async function loadCredential(): Promise<StoredCredential | null> {
  return parseStoredCredential(await getSetting(CREDENTIAL_KEY))
}

/**
 * Save a new secret. Any biometric enrolment is removed: if the secret is
 * being changed because the old one leaked, an already-enrolled finger may not
 * belong to the owner.
 */
export async function saveCredential(
  kind: SecretKind,
  secret: string,
): Promise<StoredCredential> {
  const credential = await createCredential(kind, secret)
  await saveCredentialRecord(credential)
  await removeBiometric()
  return credential
}

/**
 * Keep the legacy single-credential row in step with the owner account.
 *
 * The staff roster is the source of truth now, but an older build (or a
 * rollback) still reads `security.credential`. Writing it here avoids asking
 * the owner to set the lock again after a downgrade. Unlike `saveCredential`,
 * this deliberately leaves the biometric enrolment alone: adding a cashier
 * must not remove the owner's fingerprint.
 */
export async function saveCredentialRecord(
  credential: StoredCredential,
): Promise<void> {
  await setSetting(CREDENTIAL_KEY, JSON.stringify(credential))
}

export async function removeCredential(): Promise<void> {
  await setSetting(CREDENTIAL_KEY, '')
  await removeBiometric()
}

export async function loadBiometric(): Promise<BiometricRecord | null> {
  return parseBiometric(await getSetting(BIOMETRIC_KEY))
}

export async function saveBiometric(
  record: Pick<BiometricRecord, 'credentialId' | 'userHandle'>,
): Promise<BiometricRecord> {
  const stored: BiometricRecord = {
    v: 1,
    credentialId: record.credentialId,
    userHandle: record.userHandle,
    createdAt: Date.now(),
  }
  await setSetting(BIOMETRIC_KEY, JSON.stringify(stored))
  return stored
}

export async function removeBiometric(): Promise<void> {
  await setSetting(BIOMETRIC_KEY, '')
}
