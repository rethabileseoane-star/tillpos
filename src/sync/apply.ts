import { db, loadedShop } from '@/db'
import type { SyncEntity, SyncMeta } from '@/db/types'
import { remoteWins, stripServerFields, type RemoteRow } from './merge'
import { isSharedSettingKey } from './shared'

/**
 * Writing a pulled row onto this device.
 *
 * Crucially, this path never calls `queueEntity`. A row that came *from* the
 * server must not be queued to go back to it, or every pull would echo every
 * row forever.
 */

interface RowTable {
  get(id: string): Promise<SyncMeta | undefined>
  put(row: SyncMeta): Promise<unknown>
}

/** Entity names are the remote table names, which is why this is a plain map. */
const TABLES: Record<SyncEntity, RowTable> = {
  products: db.products as unknown as RowTable,
  sales: db.sales as unknown as RowTable,
  sale_lines: db.saleLines as unknown as RowTable,
  stock_movements: db.stockMovements as unknown as RowTable,
  cash_movements: db.cashMovements as unknown as RowTable,
  settings: db.settings as unknown as RowTable,
}

/** True while this row still has an unsynced local edit. */
export async function isPendingLocally(entity: SyncEntity, entityId: string): Promise<boolean> {
  const count = await db.outbox
    .where('entityId')
    .equals(entityId)
    .filter((item) => item.entity === entity)
    .count()
  return count > 0
}

/**
 * Apply one remote row. Returns true when the local database changed.
 *
 * Skips rows that are not ours to trust (a settings row whose key is not shared)
 * and rows that lose the last-write-wins comparison against a local edit.
 */
export async function applyRemoteRow(entity: SyncEntity, remote: RemoteRow): Promise<boolean> {
  // Defence in depth: the pull query already filters by shop, but a row from a
  // different shop must never be written even if a server or stub gets it wrong.
  if (remote.shopId !== loadedShop.id) return false

  const row = stripServerFields(remote)

  if (entity === 'settings' && !isSharedSettingKey(String(row.key ?? ''))) return false

  const table = TABLES[entity]
  const local = await table.get(row.id)

  if (local) {
    // A local edit still waiting to be pushed is the newer intent, no matter
    // what timestamps say, so it is left alone to win on the next push.
    if (await isPendingLocally(entity, row.id)) return false
    if (!remoteWins(local, row)) return false
  }

  await table.put(row)
  return true
}
