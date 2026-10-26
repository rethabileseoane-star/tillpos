import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { loadedShop } from '@/db'
import { loadSyncConfig } from './config'

/**
 * The Supabase client and the shop sign-in.
 *
 * Signing in with email and password replaces the old "paste an access token"
 * field: those tokens expire within the hour, which silently killed a sync that
 * was supposed to run unattended for months. The session is persisted under a
 * `till.` storage key, so it is refreshed automatically and is wiped along with
 * the rest of the app's local data on a factory reset.
 *
 * The client is created lazily behind a dynamic import so the Supabase SDK
 * stays out of the main bundle and the precache until sync is turned on.
 */

let cached: { key: string; client: SupabaseClient } | null = null

/** Each shop's cloud session lives under its own key. */
export function sessionStorageKey(shopId: string): string {
  return `till.supabase.auth.${shopId}`
}

/**
 * The old build stored shop A's session without a shop suffix. Copy it once so
 * an existing phone does not have to sign in again after updating.
 */
function migrateLegacySession(shopId: string): void {
  if (shopId !== 'shop-a') return
  const next = sessionStorageKey(shopId)
  try {
    if (localStorage.getItem(next)) return
    const legacy = localStorage.getItem('till.supabase.auth')
    if (legacy) localStorage.setItem(next, legacy)
  } catch {
    // Storage unavailable: the client will simply ask for a sign-in.
  }
}

export async function getClient(): Promise<SupabaseClient | null> {
  const cfg = await loadSyncConfig()
  if (!cfg) return null

  const shopId = loadedShop.id
  const key = `${cfg.url}|${cfg.anonKey}|${shopId}`
  if (cached && cached.key === key) return cached.client

  migrateLegacySession(shopId)
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The app uses hash routing, so Supabase must not try to read a session
      // out of the URL fragment.
      detectSessionInUrl: false,
      storageKey: sessionStorageKey(shopId),
    },
  })
  cached = { key, client }
  return client
}

/** Drop the cached client, e.g. after the project URL changes. */
export function forgetClient(): void {
  cached = null
}

/** The `app_metadata.shop_id` claim on a session, when it has one. */
export function sessionShopId(session: Session | null): string | null {
  const value = session?.user?.app_metadata?.shop_id
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

/** A sentence for a login that belongs to a different (or no) shop. */
export function shopClaimError(expected: string, actual: string | null): string {
  if (!actual) {
    return (
      `This cloud login has no shop code. In Supabase, open Authentication → Users, ` +
      `edit this user's app_metadata, and set shop_id to “${expected}”.`
    )
  }
  return (
    `This cloud login belongs to shop “${actual}”, but this phone is in shop “${expected}”. ` +
    `Use that shop's own sync login, or correct app_metadata.shop_id in Supabase.`
  )
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = await getClient()
  if (!client) return { ok: false, error: 'Enter the project URL and anon key first.' }

  const expected = loadedShop.id
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  if (error) return { ok: false, error: error.message }
  if (!data.session) return { ok: false, error: 'The server returned no session.' }

  const actual = sessionShopId(data.session)
  if (actual !== expected) {
    // Never leave a session for the wrong shop cached: it could read that
    // shop's cloud rows if the local filter were ever bypassed.
    await client.auth.signOut().catch(() => undefined)
    return { ok: false, error: shopClaimError(expected, actual) }
  }
  return { ok: true }
}

export async function signOut(): Promise<void> {
  const client = await getClient()
  await client?.auth.signOut()
}

export async function currentSession(): Promise<Session | null> {
  const client = await getClient()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) return null
  return data.session ?? null
}

export async function signedInEmail(): Promise<string | null> {
  const session = await currentSession()
  return session?.user?.email ?? null
}
