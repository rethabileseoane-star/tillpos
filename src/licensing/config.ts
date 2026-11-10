import { LICENSE_PUBLIC_JWK } from './publicKey.generated'

/**
 * The seller's licence service.
 *
 * This is deliberately separate from the customer's shop Sync settings: a
 * customer may point shop sync at their own Supabase project, but the
 * subscription and device allow-list must stay under the seller's control.
 *
 * The URL and anon key are public by design. The Edge Function uses its own
 * service-role secret; that secret is never built into the app.
 */
const DEFAULT_URL = 'https://srcbrlegjewchazdocvr.supabase.co'
const DEFAULT_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyY2JybGVnamV3Y2hhemRvY3ZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NTAwOTMsImV4cCI6MjEwODMyNjA5M30.ZswF7pQ7lIQirGIznPl2W3Cc6SpzEIKFU2TPu3gw_C0'

function readEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parsePublicKey(value: string | undefined): JsonWebKey {
  if (!value) return LICENSE_PUBLIC_JWK
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && (parsed as JsonWebKey).kty === 'EC') {
      return parsed as JsonWebKey
    }
  } catch {
    // A bad build-time override must not break verification: fall back to the
    // compiled public key, which is the key the deployed function should use.
  }
  return LICENSE_PUBLIC_JWK
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

export const licenseConfig = {
  url: normalizeUrl(readEnv('VITE_LICENSE_URL') ?? DEFAULT_URL),
  anonKey: readEnv('VITE_LICENSE_ANON_KEY') ?? DEFAULT_ANON_KEY,
  functionName: readEnv('VITE_LICENSE_FUNCTION') ?? 'license',
  publicKey: parsePublicKey(readEnv('VITE_LICENSE_PUBLIC_JWK')),
} as const

export const licenseServerConfigured = Boolean(licenseConfig.url && licenseConfig.anonKey)

// The gate is live in production builds. `npm run dev` leaves the flag unset,
// which keeps development dormant so the till opens without a licence server or
// a key. `.env.production` sets VITE_LICENSE_DORMANT=false for real builds.
// A rollback is that one line: with it removed, every installation unlocks on
// its next check-in, which is exactly why it must not be touched while clients
// are paying.
export const licenseDormant =
  readEnv('VITE_LICENSE_DORMANT') !== '0' &&
  readEnv('VITE_LICENSE_DORMANT') !== 'false'
