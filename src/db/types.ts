import type { Cents } from '@/domain/money'

/**
 * Every row carries sync metadata from day one even though this is a
 * single-user, single-device install. When you add a second device or a second
 * operator later, no migration or rewrite is needed.
 */
export interface SyncMeta {
  /** Client-generated UUID. Never reused, so pushes are idempotent. */
  id: string
  createdAt: number
  updatedAt: number
  /** Soft delete. Tombstones must sync, otherwise deletes resurrect remotely. */
  deletedAt: number | null
  /** Monotonic revision, bumped on every local write. */
  rev: number
  /** Identifies the install that produced the row. */
  deviceId: string
}

export type StockReason = 'sale' | 'void' | 'import' | 'adjust' | 'opening' | 'purchase'

export interface Product extends SyncMeta {
  /** Primary EAN-13, UPC-A, Code128, or any other scanned payload. Indexed. */
  barcode: string
  /** Every barcode that resolves to this product (includes `barcode`). Indexed. */
  barcodes: string[]
  name: string
  /** Human-facing description / product details shown on the catalog card. */
  details?: string
  price: Cents
  /**
   * What the shop paid per unit, used to suggest the total when buying stock
   * and later to value inventory and work out profit. Falls back to `price`
   * wherever a product predates this field or was imported without a cost.
   */
  cost: Cents
  /**
   * Cached balance, kept only as a fast read. The authoritative value is the
   * sum of stock_movements; this column is repaired from that sum on load.
   */
  stockQty: number
  lowStockThreshold: number
  category: string
  active: boolean
}

/**
 * This till takes cash only. The union is kept as a type (rather than a bare
 * string literal) so a future non-cash method is a one-word change here.
 */
export type PaymentMethod = 'cash'

export interface Sale extends SyncMeta {
  /** Human-facing receipt number, sequential per local calendar day. */
  receiptNo: string
  /** Start of the local calendar day this sale belongs to. */
  businessDate: string
  subtotal: Cents
  total: Cents
  paymentMethod: PaymentMethod
  /** Cash actually handed over, so change can be shown. Null for non-cash. */
  amountTendered: Cents | null
  change: Cents | null
  status: 'completed' | 'voided'
  voidedAt: number | null
  note: string
  /**
   * Staff account that made the sale. Optional only because rows written before
   * staff accounts existed have no name; every new sale gets one.
   */
  cashierName?: string
}

export interface SaleLine extends SyncMeta {
  saleId: string
  productId: string
  /** Snapshots, so a later price edit never rewrites historical records. */
  barcode: string
  name: string
  unitPrice: Cents
  qty: number
  lineTotal: Cents
  /** True when the product was not in the catalog at scan time. */
  adHoc: boolean
}

export interface StockMovement extends SyncMeta {
  productId: string
  /** Signed. Negative for a sale, positive for a void or restock. */
  delta: number
  reason: StockReason
  /** Sale id for 'sale'/'void'; cash movement id for a 'purchase'. */
  refId: string | null
  note: string
}

export type CashReason =
  | 'sale'
  | 'void'
  | 'float'
  | 'cash_in'
  | 'purchase'
  | 'drawing'
  | 'expense'
  | 'loan_repay'

/**
 * What a "money in" movement represents. Own money is capital (owner equity);
 * borrowed money is a loan (a liability the shop owes back). Repayments drop
 * the loan balance. Rows written before this field existed are treated as
 * capital.
 */
export type CashInKind = 'capital' | 'loan'

/**
 * The cash drawer ledger.
 *
 * Stock is traced with `StockMovement` rows; the money in the drawer is traced
 * the same way. Nothing edits a balance in place — a sale appends a positive
 * row, a void appends a negative one, and the operator's float and cash-in/out
 * are simply more rows. The drawer balance is the sum of `delta`, so it can be
 * rebuilt from the ledger exactly like `products.stockQty` is.
 */
export interface CashMovement extends SyncMeta {
  reason: CashReason
  /** Signed count of tambala. Positive puts cash in the drawer, negative takes it out. */
  delta: Cents
  /** Sale id when reason is 'sale' or 'void'. */
  refId: string | null
  /** 'capital' or 'loan' when reason is 'cash_in'. Undefined rows are capital. */
  kind?: CashInKind
  businessDate: string
  note: string
}

/**
 * The synced tables. The name doubles as the remote table name, which is why
 * the snake_case members read the way they do.
 *
 * `settings` is synced too, but only the keys listed in
 * `src/sync/shared.ts`; the app lock and this device's session never leave it.
 */
export type SyncEntity =
  | 'products'
  | 'sales'
  | 'sale_lines'
  | 'stock_movements'
  | 'cash_movements'
  | 'settings'
export type SyncOp = 'upsert' | 'delete'

export interface OutboxItem {
  id?: number
  entity: SyncEntity
  entityId: string
  op: SyncOp
  payload: string
  createdAt: number
  attempts: number
  lastError: string | null
}

export interface AppSettings extends SyncMeta {
  key: string
  value: string
}

export interface ProductDraft {
  barcode: string
  /** Additional barcodes that resolve to this product. */
  barcodes?: string[]
  name: string
  /** Human-facing product details / description. */
  details?: string
  price: Cents
  /**
   * What the shop paid per unit. `null` means the file did not state a cost,
   * which should fall back to the selling price rather than inventing M0.
   */
  cost: Cents | null
  stockQty: number
  /**
   * `null` means the file did not state a threshold, which is not the same as
   * stating zero. Treating them alike made it impossible to clear a threshold
   * with a re-import.
   */
  lowStockThreshold: number | null
  category: string
}