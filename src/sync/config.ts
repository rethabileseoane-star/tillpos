import { getSetting, setSetting } from '@/db'
import type { SyncEntity } from '@/db/types'

/**
 * Where the cloud copy lives, and how far this device has read.
 *
 * The config holds only the project URL and its public anon key. The signed-in
 * session is kept by the Supabase client in its own storage key, and the cursor
 * is this device's own bookmark — neither is a business record, so neither is
 * queued to the outbox.
 */

export interface SyncConfig {
  url: string
  anonKey: string
  /** Remembered so the sign-in form can be prefilled. Never used to authorise. */
  email?: string
}

const CONFIG_KEY = 'sync.config'
const CURSOR_KEY = 'sync.cursor'
const LAST_SYNC_KEY = 'sync.lastSync'

/** Accepts "abc.supabase.co" as well as a full URL, and drops trailing slashes. */
export function normalizeProjectUrl(input: string): string {
  let url = input.trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.replace(/\/+$/, '')
}

function parseConfig(raw: string | null): SyncConfig | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<SyncConfig>
    const url = typeof value.url === 'string' ? normalizeProjectUrl(value.url) : ''
    const anonKey = typeof value.anonKey === 'string' ? value.anonKey.trim() : ''
    if (!url || !anonKey) return null
    return { url, anonKey, email: typeof value.email === 'string' ? value.email : undefined }
  } catch {
    // A damaged setting must read as "not configured" rather than crash boot.
    return null
  }
}

export async function loadSyncConfig(): Promise<SyncConfig | null> {
  return parseConfig(await getSetting(CONFIG_KEY))
}

export async function saveSyncConfig(cfg: SyncConfig): Promise<void> {
  const stored: SyncConfig = {
    url: normalizeProjectUrl(cfg.url),
    anonKey: cfg.anonKey.trim(),
    email: cfg.email?.trim() || undefined,
  }
  await setSetting(CONFIG_KEY, JSON.stringify(stored))
}

/** Turn sync off. Local records and the outbox are untouched. */
export async function disableSync(): Promise<void> {
  await setSetting(CONFIG_KEY, '')
  await setSetting(CURSOR_KEY, '')
  await setSetting(LAST_SYNC_KEY, '')
}

export type SyncCursor = Partial<Record<SyncEntity, number>>

export async function loadCursors(): Promise<SyncCursor> {
  const raw = await getSetting(CURSOR_KEY)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return {}
    const cursors: SyncCursor = {}
    for (const [entity, seq] of Object.entries(value as Record<string, unknown>)) {
      if (typeof seq === 'number' && Number.isFinite(seq)) {
        cursors[entity as SyncEntity] = seq
      }
    }
    return cursors
  } catch {
    return {}
  }
}

export async function saveCursors(cursors: SyncCursor): Promise<void> {
  await setSetting(CURSOR_KEY, JSON.stringify(cursors))
}

export async function loadLastSyncAt(): Promise<number | null> {
  const raw = await getSetting(LAST_SYNC_KEY)
  const value = raw ? Number(raw) : 0
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function setLastSyncAt(ms: number): Promise<void> {
  await setSetting(LAST_SYNC_KEY, String(ms))
}
