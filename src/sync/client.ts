import type { Session, SupabaseClient } from '@supabase/supabase-js'
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

export async function getClient(): Promise<SupabaseClient | null> {
  const cfg = await loadSyncConfig()
  if (!cfg) return null

  const key = `${cfg.url}|${cfg.anonKey}`
  if (cached && cached.key === key) return cached.client

  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The app uses hash routing, so Supabase must not try to read a session
      // out of the URL fragment.
      detectSessionInUrl: false,
      storageKey: 'till.supabase.auth',
    },
  })
  cached = { key, client }
  return client
}

/** Drop the cached client, e.g. after the project URL changes. */
export function forgetClient(): void {
  cached = null
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = await getClient()
  if (!client) return { ok: false, error: 'Enter the project URL and anon key first.' }

  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  if (error) return { ok: false, error: error.message }
  if (!data.session) return { ok: false, error: 'The server returned no session.' }
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
