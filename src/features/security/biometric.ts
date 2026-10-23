import {
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
} from './secret'

/**
 * Biometric unlock through WebAuthn's platform authenticator.
 *
 * Registration binds a credential to this origin, and unlocking asks the
 * operating system to verify the user (fingerprint, face or the device PIN)
 * before it releases an assertion. The app accepts a successful assertion
 * without validating its signature, because there is no server to hold a
 * public key: the gate is local, and any attacker able to forge the JavaScript
 * running here could ignore the gate entirely.
 *
 * Always paired with a PIN/password. Credentials live in the OS/browser
 * keystore and disappear if that is reset, so biometrics can never be the only
 * way in.
 */

const RP_NAME = 'Till POS'
const TIMEOUT_MS = 60_000

export type BiometricFailure = 'unsupported' | 'cancelled' | 'failed'

export type BiometricResult =
  | { ok: true }
  | { ok: false; reason: BiometricFailure; message: string }

export interface BiometricEnrolment {
  credentialId: string
  userHandle: string
}

export type EnrolResult =
  | { ok: true; record: BiometricEnrolment }
  | { ok: false; reason: BiometricFailure; message: string }

/**
 * WebAuthn refuses IP-address relying parties, which matters because the till
 * is often opened at https://192.168.x.x. Registration would fail there with a
 * SecurityError, so say so up front instead of offering a button that cannot
 * work. A hostname (including localhost) is fine.
 */
function hostIsIpAddress(): boolean {
  const host = location.hostname
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

export function biometricSupportNote(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'Biometric unlock is not available here.'
  }
  if (!window.isSecureContext) {
    return 'Biometric unlock needs HTTPS or localhost.'
  }
  if (hostIsIpAddress()) {
    return 'Biometric unlock is not available at a numeric IP address. Use a hostname, or unlock with your PIN.'
  }
  if (
    typeof PublicKeyCredential === 'undefined' ||
    !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  ) {
    return 'This browser does not support biometric unlock.'
  }
  return null
}

export function biometricsSupported(): boolean {
  return biometricSupportNote() === null
}

export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!biometricsSupported()) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

function describeFailure(err: unknown, action: 'create' | 'get'): {
  reason: BiometricFailure
  message: string
} {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return {
        reason: 'cancelled',
        message:
          action === 'create'
            ? 'No fingerprint or face was enrolled, or the prompt was dismissed.'
            : 'Biometric unlock was cancelled.',
      }
    }
    if (err.name === 'SecurityError' || err.name === 'NotSupportedError') {
      return {
        reason: 'unsupported',
        message: 'This device or address does not allow biometric unlock.',
      }
    }
    if (err.name === 'InvalidStateError') {
      return {
        reason: 'failed',
        message: 'This device is already enrolled. Remove biometrics first, then add them again.',
      }
    }
  }
  return {
    reason: 'failed',
    message:
      err instanceof Error
        ? err.message
        : 'Biometric unlock did not work. Use your PIN or password.',
  }
}

/** Ask the OS to enrol the platform authenticator for this origin. */
export async function enrollBiometric(): Promise<EnrolResult> {
  const note = biometricSupportNote()
  if (note) return { ok: false, reason: 'unsupported', message: note }

  const userHandle = crypto.getRandomValues(new Uint8Array(16))
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME },
        user: {
          // Opaque: the till has no account server, so no real user id to name.
          id: userHandle,
          name: 'till-owner',
          displayName: 'Till owner',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: TIMEOUT_MS,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null

    if (!credential) {
      return {
        ok: false,
        reason: 'failed',
        message: 'The device did not create a biometric credential.',
      }
    }
    return {
      ok: true,
      record: {
        credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
        userHandle: bytesToBase64(userHandle),
      },
    }
  } catch (err) {
    const failure = describeFailure(err, 'create')
    return { ok: false, ...failure }
  }
}

/** Ask the OS to verify the owner against the saved credential. */
export async function unlockWithBiometric(
  record: { credentialId: string },
): Promise<BiometricResult> {
  const note = biometricSupportNote()
  if (note) return { ok: false, reason: 'unsupported', message: note }

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          { type: 'public-key', id: base64UrlToBytes(record.credentialId) },
        ],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
      },
    })
    if (!assertion) {
      return {
        ok: false,
        reason: 'failed',
        message: 'No biometric match. Use your PIN or password.',
      }
    }
    return { ok: true }
  } catch (err) {
    const failure = describeFailure(err, 'get')
    return { ok: false, ...failure }
  }
}
