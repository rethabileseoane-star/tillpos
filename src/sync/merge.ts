import type { SyncEntity, SyncMeta } from '@/db/types'

/**
 * Merge rules for rows that arrive from another device.
 *
 * Kept free of any IndexedDB or network import so `tools/smoke.ts` can test the
 * ordering rules without a browser, and so the rule lives in exactly one place.
 */

/** A row as it comes back from Postgres, including the trigger's extra columns. */
export type RemoteRow = SyncMeta & Record<string, unknown>

/**
 * Every synced table, in push order.
 *
 * Parents come before children (`sales` before `sale_lines`) so a foreign key
 * never arrives before the row it points at.
 */
export const SYNC_ENTITIES: SyncEntity[] = [
  'products',
  'sales',
  'sale_lines',
  'stock_movements',
  'cash_movements',
  'settings',
]

/** Columns the SQL trigger owns. They are a pull cursor, never local data. */
export function stripServerFields(row: RemoteRow): RemoteRow {
  const clean: Record<string, unknown> = { ...row }
  delete clean.serverSeq
  delete clean.serverUpdatedAt
  // The cloud tags every row with its shop. Local tables are already one shop,
  // so the tag is not stored and cannot leak into a backup or a local query.
  delete clean.shopId
  return clean as RemoteRow
}

/** Add the active shop to an outbound row. */
export function withShopId(row: RemoteRow, shopId: string): RemoteRow {
  return { ...row, shopId }
}

/**
 * Does the remote copy of a row beat the one already on this device?
 *
 * The newest edit wins, judged by the edit time the writing device stamped.
 * `rev` breaks a tie on the same millisecond, and `deviceId` breaks a tie on
 * both so that every device reaches the same answer without talking to the
 * others — otherwise two devices could each keep their own version forever.
 *
 * Callers must check the pending outbox first: a row still waiting to be pushed
 * is this device's newest intent and must never be overwritten by an older
 * remote copy.
 */
export function remoteWins(local: SyncMeta, remote: SyncMeta): boolean {
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt
  if (remote.rev !== local.rev) return remote.rev > local.rev
  return remote.deviceId < local.deviceId
}
