import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { licenseConfig } from './config'

/**
 * The seller's admin client. It signs in to the licence project with a normal
 * Supabase Auth user. RLS only lets a user in `license_admins` read or change
 * licence rows; the public app can see this screen but not the data.
 *
 * The storage key is separate from shop sync, so signing into the admin does
 * not disturb a shop's cloud session.
 */
let cached: SupabaseClient | null = null

export async function getAdminClient(): Promise<SupabaseClient> {
  if (cached) return cached
  const { createClient } = await import('@supabase/supabase-js')
  cached = createClient(licenseConfig.url, licenseConfig.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'till.license.admin.auth',
    },
  })
  return cached
}

export async function adminSignIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await getAdminClient()
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch {
    return { ok: false, error: 'The licence project could not be reached.' }
  }
}

export async function adminSignOut(): Promise<void> {
  try {
    const client = await getAdminClient()
    await client.auth.signOut()
  } catch {
    // Signing out is best-effort; the local session will be gone anyway.
  }
}

export async function adminSession(): Promise<Session | null> {
  try {
    const client = await getAdminClient()
    const { data } = await client.auth.getSession()
    return data.session ?? null
  } catch {
    return null
  }
}
