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

function parseStoredCredential(raw: string | null): StoredCredential | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredCredential>
    const validLength =
      value.kind === 'pin'
        ? typeof value.length === 'number' && value.length >= PIN_MIN && value.length <= PIN_MAX
        : typeof value.length === 'number' &&
          value.length >= PASSWORD_MIN &&
          value.length <= PASSWORD_MAX
    const valid =
      value.v === 1 &&
      (value.kind === 'pin' || value.kind === 'password') &&
      validLength &&
      value.algorithm === 'PBKDF2-SHA-256' &&
      typeof value.iterations === 'number' &&
      value.iterations >= 5_000 &&
      value.iterations <= 2_000_000 &&
      typeof value.salt === 'string' &&
      value.salt.length > 0 &&
      typeof value.hash === 'string' &&
      value.hash.length > 0
    return valid ? (value as StoredCredential) : null
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
  await setSetting(CREDENTIAL_KEY, JSON.stringify(credential))
  await removeBiometric()
  return credential
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
