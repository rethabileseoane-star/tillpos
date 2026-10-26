import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { db, getSetting, loadedShop, repairStockCache, setSetting } from '@/db'
import type { SyncEntity } from '@/db/types'
import { applyRemoteRow } from './apply'
import { getClient, sessionShopId, shopClaimError, signedInEmail } from './client'
import {
  loadCursors,
  loadLastSyncAt,
  loadSyncConfig,
  saveCursors,
  setLastSyncAt,
  type SyncCursor,
} from './config'
import { SYNC_ENTITIES, withShopId, type RemoteRow } from './merge'
import { isSharedSettingKey } from './shared'
import { setSyncState } from './status'

/**
 * The sync loop: push this device's outbox, then pull everything newer.
 *
 * Both halves are safe to run at any time and any number of times. Pushing is
 * idempotent (rows carry their own UUID, so an upsert is a no-op the second
 * time), and pulling is guided by a per-table cursor, so an interrupted run
 * simply resumes where it stopped.
 */

const PULL_BATCH = 500
const PUSH_BATCH = 200
const MAX_ATTEMPTS = 5
const RETRY_RESET_FLAG = 'sync.retryResetAfterShopUpgrade'

export type SyncSkip = 'disabled' | 'signed-out' | 'offline'

export interface SyncOutcome {
  ok: boolean
  pushed: number
  pulled: number
  skipped?: SyncSkip
  error?: string
}

/**
 * Every synced table now has a composite `(shopId, id)` primary key. Stating
 * the conflict target explicitly means an upsert does not depend on PostgREST's
 * cached idea of the primary key after a schema change.
 */
const UPSERT_OPTIONS = { onConflict: 'shopId,id' } as const

/**
 * The signed-in session, refreshed once if it predates the shop claim.
 *
 * A phone that was signed in before multi-shop has a valid token without
 * `app_metadata.shop_id`. Supabase only copies changed app metadata into a new
 * token, so refreshing once is what upgrades that session without asking the
 * owner to type the password again.
 */
async function sessionForShop(
  client: SupabaseClient,
): Promise<{ session: Session | null; error?: string; signedOut?: boolean }> {
  const { data, error } = await client.auth.getSession()
  if (error || !data.session) return { session: null, signedOut: true }

  const expected = loadedShop.id
  let session = data.session
  let actual = sessionShopId(session)

  if (!actual) {
    const refreshed = await client.auth.refreshSession()
    if (refreshed.data.session) {
      session = refreshed.data.session
      actual = sessionShopId(session)
    }
  }

  if (actual !== expected) return { session, error: shopClaimError(expected, actual) }
  return { session }
}

/**
 * Give rows stranded by the single-shop schema change one more chance.
 *
 * An old build that was still open when the cloud gained the required `shopId`
 * column could fail the same queued row five times and park it. Those edits are
 * still safe in the local outbox, but the normal push loop deliberately skips
 * parked rows. On the first successful sync after upgrading, reset the attempt
 * counter once so nothing made before the upgrade is left behind.
 */
async function resetStalledOutboxOnce(): Promise<void> {
  // Only set the once-only marker after actually rescuing parked rows. An old
  // build in another tab could still be running during the upgrade and park a
  // row after this tab's first successful sync; leaving the marker unset lets
  // that row be rescued too. Once a rescue happens, the marker stops any
  // genuinely bad payload from being retried forever.
  if ((await getSetting(RETRY_RESET_FLAG)) === '1') return
  const stalled = await db.outbox.filter((item) => item.attempts >= MAX_ATTEMPTS).toArray()
  if (stalled.length === 0) return
  await db.outbox.bulkPut(stalled.map((item) => ({ ...item, attempts: 0, lastError: null })))
  await setSetting(RETRY_RESET_FLAG, '1')
}

/**
 * Send every queued local change.
 *
 * Items are sent oldest first so a sale always lands before its lines and
 * stock movements. An item is only removed once the server acknowledges it,
 * so a dropped connection loses nothing. A row that keeps failing is parked
 * after `MAX_ATTEMPTS` and no longer blocks the rest of the queue.
 */
async function pushOutbox(
  client: SupabaseClient,
  shopId: string,
): Promise<{ pushed: number; stalled: number; error?: string }> {
  const items = await db.outbox.orderBy('createdAt').toArray()
  let pushed = 0
  let stalled = 0

  for (const item of items) {
    if (item.id === undefined) continue
    if (item.attempts >= MAX_ATTEMPTS) {
      stalled++
      continue
    }

    let row: RemoteRow
    try {
      row = JSON.parse(item.payload) as RemoteRow
    } catch {
      // Unreadable payload: it can never be sent, so stop it blocking the queue.
      await db.outbox.delete(item.id)
      continue
    }

    if (item.entity === 'settings' && !isSharedSettingKey(String(row.key ?? ''))) {
      // Never send a lock digest, session or cursor to the cloud.
      await db.outbox.delete(item.id)
      continue
    }

    const { error } = await client
      .from(item.entity)
      .upsert(withShopId(row, shopId), UPSERT_OPTIONS)
    if (error) {
      await db.outbox.update(item.id, {
        attempts: item.attempts + 1,
        lastError: error.message,
      })
      return { pushed, stalled, error: `${error.message} (${item.entity})` }
    }

    await db.outbox.delete(item.id)
    pushed++
  }

  return { pushed, stalled }
}

/**
 * Read every row changed on any device since this one last looked.
 *
 * The cursor is advanced to the highest `serverSeq` seen, whether or not the
 * row was kept, so a row this device rejects (a newer local edit) is never
 * fetched again.
 */
async function pullChanges(
  client: SupabaseClient,
  cursors: SyncCursor,
  shopId: string,
): Promise<{ pulled: number; changedStock: boolean }> {
  let pulled = 0
  let changedStock = false

  for (const entity of SYNC_ENTITIES) {
    let cursor = cursors[entity] ?? 0

    for (;;) {
      const { data, error } = await client
        .from(entity)
        .select('*')
        .eq('shopId', shopId)
        .gt('serverSeq', cursor)
        .order('serverSeq', { ascending: true })
        .limit(PULL_BATCH)
      if (error) throw new Error(`${error.message} (${entity})`)

      const rows = (data ?? []) as unknown as RemoteRow[]
      if (rows.length === 0) break

      for (const raw of rows) {
        const applied = await applyRemoteRow(entity, raw)
        if (applied) {
          pulled++
          if (entity === 'stock_movements' || entity === 'products') changedStock = true
        }
      }

      const maxSeq = rows.reduce((max, row) => Math.max(max, Number(row.serverSeq ?? 0)), cursor)
      if (maxSeq <= cursor) break // defensive: the server did not advance the cursor
      cursor = maxSeq
      cursors[entity] = cursor
      await saveCursors(cursors)

      setSyncState({ pulled })
      if (rows.length < PULL_BATCH) break
    }
  }

  return { pulled, changedStock }
}

/** One full push-then-pull. Never throws; failures come back in the outcome. */
export async function syncNow(): Promise<SyncOutcome> {
  const cfg = await loadSyncConfig()
  if (!cfg) {
    setSyncState({ enabled: false, email: null, pending: await db.outbox.count() })
    return { ok: false, pushed: 0, pulled: 0, skipped: 'disabled' }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setSyncState({ enabled: true, pending: await db.outbox.count() })
    return { ok: false, pushed: 0, pulled: 0, skipped: 'offline' }
  }

  const client = await getClient()
  if (!client) return { ok: false, pushed: 0, pulled: 0, skipped: 'disabled' }

  const shopId = loadedShop.id
  const auth = await sessionForShop(client)
  if (!auth.session) {
    setSyncState({ enabled: true, email: null, pending: await db.outbox.count() })
    return { ok: false, pushed: 0, pulled: 0, skipped: 'signed-out' }
  }
  if (auth.error) {
    setSyncState({
      enabled: true,
      email: auth.session.user.email ?? null,
      running: false,
      phase: 'idle',
      error: auth.error,
      pending: await db.outbox.count(),
    })
    return { ok: false, pushed: 0, pulled: 0, error: auth.error }
  }

  setSyncState({
    enabled: true,
    email: auth.session.user.email ?? null,
    running: true,
    phase: 'pushing',
    error: null,
  })

  try {
    await resetStalledOutboxOnce()
    const push = await pushOutbox(client, shopId)

    setSyncState({ phase: 'pulling', pushed: push.pushed })
    const cursors = await loadCursors()
    const pull = await pullChanges(client, cursors, shopId)

    // Stock balances are cached from the movement ledger, and the ledger just
    // grew, so recompute them from the merged movements.
    if (pull.changedStock) await repairStockCache()

    const at = Date.now()
    await setLastSyncAt(at)
    setSyncState({
      running: false,
      phase: 'idle',
      lastSyncAt: at,
      pushed: push.pushed,
      pulled: pull.pulled,
      pending: await db.outbox.count(),
      error: push.error ?? null,
    })
    return { ok: !push.error, pushed: push.pushed, pulled: pull.pulled, error: push.error }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSyncState({ running: false, phase: 'idle', error: message, pending: await db.outbox.count() })
    return { ok: false, pushed: 0, pulled: 0, error: message }
  }
}

/** Read the stored config and session into the status store, for the UI. */
export async function refreshSyncStatus(): Promise<void> {
  const cfg = await loadSyncConfig()
  const pending = await db.outbox.count()
  if (!cfg) {
    setSyncState({ enabled: false, email: null, lastSyncAt: null, pending })
    return
  }
  setSyncState({
    enabled: true,
    email: await signedInEmail(),
    lastSyncAt: await loadLastSyncAt(),
    pending,
  })
}

/** Every local row of one entity, as it would be sent to the cloud. */
async function rowsFor(entity: SyncEntity): Promise<RemoteRow[]> {
  switch (entity) {
    case 'products':
      return (await db.products.toArray()) as unknown as RemoteRow[]
    case 'sales':
      return (await db.sales.toArray()) as unknown as RemoteRow[]
    case 'sale_lines':
      return (await db.saleLines.toArray()) as unknown as RemoteRow[]
    case 'stock_movements':
      return (await db.stockMovements.toArray()) as unknown as RemoteRow[]
    case 'cash_movements':
      return (await db.cashMovements.toArray()) as unknown as RemoteRow[]
    case 'settings': {
      const rows = await db.settings.toArray()
      return rows.filter((row) => isSharedSettingKey(row.key)) as unknown as RemoteRow[]
    }
  }
}

/**
 * Send every record on this device, not just the queued changes.
 *
 * This is the first-run step for the device that already holds a shop's
 * history: the outbox only knows about edits made since the app was installed,
 * so a full upload is what makes sure the ledger is complete in the cloud
 * before other devices are pointed at it.
 */
export async function uploadEverything(): Promise<{
  ok: boolean
  pushed: number
  error?: string
}> {
  const client = await getClient()
  if (!client) return { ok: false, pushed: 0, error: 'Sync is not configured.' }

  const shopId = loadedShop.id
  const auth = await sessionForShop(client)
  if (!auth.session) return { ok: false, pushed: 0, error: 'Sign in first.' }
  if (auth.error) return { ok: false, pushed: 0, error: auth.error }

  setSyncState({ running: true, phase: 'pushing', error: null })
  let pushed = 0
  try {
    for (const entity of SYNC_ENTITIES) {
      const rows = await rowsFor(entity)
      for (let i = 0; i < rows.length; i += PUSH_BATCH) {
        const slice = rows
          .slice(i, i + PUSH_BATCH)
          .map((row) => withShopId(row, shopId))
        const { error } = await client
          .from(entity)
          .upsert(slice, UPSERT_OPTIONS)
        if (error) throw new Error(`${error.message} (${entity})`)
        pushed += slice.length
      }
    }
    // Everything local is now on the server, so the queue has nothing left to
    // add and re-sending it would only burn bandwidth.
    await db.outbox.clear()
    setSyncState({ running: false, phase: 'idle', pending: 0, pushed })
    return { ok: true, pushed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSyncState({ running: false, phase: 'idle', error: message })
    return { ok: false, pushed, error: message }
  }
}
