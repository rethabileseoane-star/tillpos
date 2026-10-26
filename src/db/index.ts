import Dexie, { type Table } from 'dexie'
import { getActiveShop, type ShopProfile } from '@/shops/registry'
import type {
  AppSettings,
  CashMovement,
  OutboxItem,
  Product,
  Sale,
  SaleLine,
  StockMovement,
  SyncMeta,
} from './types'

/**
 * The shop this page was opened for.
 *
 * The registry lives in localStorage and another tab could switch it while this
 * tab is running. `db` cannot change without a reload, so every database and
 * cloud operation in this tab must use the shop captured at module load, not
 * the registry's current value. Otherwise a background sync in the old tab
 * could tag its rows with the newly selected shop.
 */
export const loadedShop: ShopProfile = getActiveShop()

/** Stable per-install identifier. Stored in localStorage so it survives reloads. */
export function getDeviceId(): string {
  const KEY = 'till.deviceId'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

export class TillDatabase extends Dexie {
  products!: Table<Product, string>
  sales!: Table<Sale, string>
  saleLines!: Table<SaleLine, string>
  stockMovements!: Table<StockMovement, string>
  cashMovements!: Table<CashMovement, string>
  settings!: Table<AppSettings, string>
  outbox!: Table<OutboxItem, number>

  constructor(name: string = loadedShop.dbName) {
    super(name)

    // Bump this integer for any future schema change.
    this.version(1).stores({
      products: 'id, barcode, name, category, active, updatedAt, deletedAt, [barcode+deletedAt]',
      sales: 'id, receiptNo, businessDate, status, createdAt, updatedAt, deletedAt, [businessDate+status]',
      saleLines: 'id, saleId, productId, barcode',
      stockMovements: 'id, productId, reason, refId, createdAt, [productId+createdAt]',
      settings: 'id, key, updatedAt',
      outbox: '++id, entity, entityId, createdAt',
    })

    // v2 adds the cash drawer ledger. Dexie carries the v1 stores forward, but
    // they are repeated here so the full schema is readable in one place.
    this.version(2).stores({
      products: 'id, barcode, name, category, active, updatedAt, deletedAt, [barcode+deletedAt]',
      sales: 'id, receiptNo, businessDate, status, createdAt, updatedAt, deletedAt, [businessDate+status]',
      saleLines: 'id, saleId, productId, barcode',
      stockMovements: 'id, productId, reason, refId, createdAt, [productId+createdAt]',
      cashMovements: 'id, reason, refId, businessDate, createdAt, [businessDate+reason]',
      settings: 'id, key, updatedAt',
      outbox: '++id, entity, entityId, createdAt',
    })

    // v3 adds multiple barcodes per product and a product-details field.
    // Existing records get `barcodes` backfilled to `[barcode]` and `details`
    // left undefined.
    // `barcodes` is a multiEntry index only. Declaring it both plainly and as
    // `*barcodes` makes IndexedDB throw ConstraintError ("index already
    // exists") during the v2→v3 upgrade, because Dexie issues two createIndex
    // calls for the same name.
    this.version(3)
      .stores({
        products:
          'id, barcode, name, category, active, updatedAt, deletedAt, [barcode+deletedAt], *barcodes',
        sales: 'id, receiptNo, businessDate, status, createdAt, updatedAt, deletedAt, [businessDate+status]',
        saleLines: 'id, saleId, productId, barcode',
        stockMovements: 'id, productId, reason, refId, createdAt, [productId+createdAt]',
        cashMovements: 'id, reason, refId, businessDate, createdAt, [businessDate+reason]',
        settings: 'id, key, updatedAt',
        outbox: '++id, entity, entityId, createdAt',
      })
      .upgrade(async (tx) => {
        const products = await tx.table('products').toArray()
        await tx.table('products').bulkPut(
          products.map((p) => ({
            ...p,
            barcodes: p.barcodes ?? (p.barcode ? [p.barcode] : []),
          })),
        )
      })

    // Scan-time lookup is the hottest path in the app.
    this.products!.hook('creating', (_pk, obj) => {
      const p = obj as Product
      p.barcode = p.barcode?.trim()
      if (!p.barcodes || p.barcodes.length === 0) p.barcodes = p.barcode ? [p.barcode] : []
    })
  }
}

export const db = new TillDatabase(loadedShop.dbName)

/** Populate sync metadata. `rev` increments so last-write-wins can be ordered. */
export function withSyncMeta<T extends object>(
  existing: SyncMeta | undefined,
  data: T,
): T & SyncMeta {
  const now = Date.now()
  if (existing) {
    return {
      ...data,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      // Preserve any tombstone the caller is not explicitly changing.
      deletedAt:
        'deletedAt' in data
          ? ((data as { deletedAt?: number | null }).deletedAt ?? null)
          : (existing.deletedAt ?? null),
      rev: existing.rev + 1,
      deviceId: existing.deviceId,
    } as T & SyncMeta
  }
  return {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    deviceId: getDeviceId(),
  } as T & SyncMeta
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.settings.where('key').equals(key).first()
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  const existing = await db.settings.where('key').equals(key).first()
  await db.settings.put(withSyncMeta(existing, { key, value }))
}

/**
 * Recompute every product's cached stock from the movement ledger.
 *
 * The ledger is authoritative. `products.stockQty` is only a cache, so this
 * makes the cache self-healing after an import, a partial write, or a future
 * sync that delivered movements out of order.
 */
export async function repairStockCache(): Promise<void> {
  const movements = await db.stockMovements.toArray()
  const totals = new Map<string, number>()
  for (const m of movements) {
    totals.set(m.productId, (totals.get(m.productId) ?? 0) + m.delta)
  }
  await db.transaction('rw', db.products, db.stockMovements, async () => {
    const products = await db.products.toArray()
    await Promise.all(
      products.map((p) => {
        const correct = totals.get(p.id) ?? 0
        if (p.stockQty === correct) return undefined
        // Deliberately does not touch `updatedAt`. This is a derived cache, not
        // an edit, and stamping it "now" would make it look like the newest
        // change and beat a real price or name edit made on another device.
        return db.products.update(p.id, { stockQty: correct })
      }),
    )
  })
}