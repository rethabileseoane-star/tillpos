import { db } from '@/db'
import Dexie from 'dexie'
import { listShops } from '@/shops/registry'
import { isSharedSettingKey } from '@/sync/shared'
import type {
  AppSettings,
  CashMovement,
  OutboxItem,
  Product,
  Sale,
  SaleLine,
  StockMovement,
} from '@/db/types'
import { downloadBlob } from '@/features/catalog/csvImport'

/**
 * Emergency backup and wipe for the "forgot PIN" path.
 *
 * The archive contains every business table. The lock digest and biometric
 * enrolment are deliberately removed (a backup is not a way to restore a
 * forgotten lock), along with the sync config, cursor and session bookkeeping,
 * neither of which belongs in a file handed to an accountant.
 *
 * There is no in-app restore yet. A JSON archive is readable and complete,
 * while the catalog CSV (also offered on the recovery screen) is the part that
 * can be re-imported with the importer that already exists.
 */

export interface TillBackup {
  app: 'till-pos'
  version: 1
  exportedAt: string
  tables: {
    products: Product[]
    sales: Sale[]
    saleLines: SaleLine[]
    stockMovements: StockMovement[]
    cashMovements: CashMovement[]
    settings: AppSettings[]
    outbox: OutboxItem[]
  }
}

/** Settings that must never leave the device in a backup. */
function isPrivateSetting(key: string): boolean {
  // `security.*` is the lock digest and the biometric enrolment, and `sync.*`
  // is the project URL plus this device's cursor and last-sync stamp. Neither
  // is a business record, and the first two must not travel in a file handed to
  // an accountant.
  return (
    key.startsWith('security.') ||
    key.startsWith('sync.') ||
    key.startsWith('device.')
  )
}

/**
 * The outbox can contain a pending settings edit. Keep only the shared shop
 * settings in a backup, never a queued copy of a device secret or cursor.
 */
function isExportableOutboxItem(item: OutboxItem): boolean {
  if (item.entity !== 'settings') return true
  try {
    const row = JSON.parse(item.payload) as { key?: unknown }
    return typeof row.key === 'string' && isSharedSettingKey(row.key)
  } catch {
    return false
  }
}

export async function buildBackup(): Promise<TillBackup> {
  const [products, sales, saleLines, stockMovements, cashMovements, settings, outbox] =
    await Promise.all([
      db.products.toArray(),
      db.sales.toArray(),
      db.saleLines.toArray(),
      db.stockMovements.toArray(),
      db.cashMovements.toArray(),
      db.settings.toArray(),
      db.outbox.toArray(),
    ])

  return {
    app: 'till-pos',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {
      products,
      sales,
      saleLines,
      stockMovements,
      cashMovements,
      settings: settings.filter((s) => !isPrivateSetting(s.key)),
      outbox: outbox.filter(isExportableOutboxItem),
    },
  }
}

export async function downloadBackupJson(): Promise<void> {
  const backup = await buildBackup()
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  downloadBlob(blob, `till-backup-${new Date().toISOString().slice(0, 10)}.json`)
}

/**
 * Delete every shop's local database and this app's localStorage keys.
 *
 * This is the "forgot the lock" reset, so it is deliberately whole-device: a
 * phone may hold shop A and shop B, and leaving one database behind would leave
 * a lock whose password was also lost. The cloud copies are not touched.
 *
 * Closing happens inside Dexie's delete(), so the caller only has to reload
 * afterwards. Only `till.*` keys are touched (which includes the shop registry
 * and cached Supabase sessions); anything else on the origin is left alone.
 */
export async function eraseLocalData(): Promise<void> {
  const names = new Set(listShops().map((shop) => shop.dbName))

  // A registry can be damaged or missing after a browser cleanup. Sweep any
  // other database this app has created so a reset really is a reset.
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>
  }
  try {
    const found = await factory.databases?.()
    for (const info of found ?? []) {
      if (info.name?.startsWith('till-pos')) names.add(info.name)
    }
  } catch {
    // `databases()` is not available in every browser; the registry names are
    // still enough for the normal case.
  }

  for (const name of names) {
    if (name === db.name) await db.delete()
    else await Dexie.delete(name)
  }

  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('till.') || key?.startsWith('sb-')) keys.push(key)
  }
  for (const key of keys) localStorage.removeItem(key)
}
