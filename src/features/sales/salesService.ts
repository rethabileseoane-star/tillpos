import { db, withSyncMeta, getDeviceId } from '@/db'
import type { CashMovement, Product, Sale, SaleLine, StockMovement } from '@/db/types'
import type { Cents } from '@/domain/money'
import { normalizeBarcode } from '@/domain/barcode'
import type { CartLine } from '@/features/cart/cartStore'
import { cartSubtotal } from '@/features/cart/cartStore'
import { loadTillLabel } from '@/features/settings/tillLabel'
import { queueEntity } from '@/sync/outbox'

/** Local calendar day as YYYY-MM-DD. Day boundaries follow the device clock. */
export function businessDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * The next receipt number for this till, on this day.
 *
 * Only this device's own sales are counted. Counting the whole day would make a
 * second till skip numbers (it would see the first till's, which synced in) and
 * hand out the same number as the first till if it had not synced yet. The
 * label is what separates two tills selling at the same moment: A-0001 next to
 * B-0001. A device with no label keeps plain numbering.
 */
async function nextReceiptNo(date: string, deviceId: string, label: string): Promise<string> {
  const todays = await db.sales.where('businessDate').equals(date).toArray()
  const mine = todays.filter((sale) => sale.deviceId === deviceId).length
  const sequence = String(mine + 1).padStart(4, '0')
  return label ? `${label}-${sequence}` : sequence
}

export interface CommitInput {
  lines: CartLine[]
  paymentMethod: Sale['paymentMethod']
  amountTendered: Cents | null
  note?: string
}

/**
 * Commit a sale.
 *
 * The sale, its lines, and the resulting stock movements are written in a single
 * transaction so the ledger can never end up with a sale that has no lines or a
 * stock change with no sale. Ad-hoc lines create a product first so stock and
 * reprints still work later.
 */
export async function commitSale(input: CommitInput): Promise<Sale> {
  if (input.lines.length === 0) throw new Error('Cart is empty')

  const subtotal = cartSubtotal(input.lines)
  if (input.paymentMethod === 'cash' && input.amountTendered !== null && input.amountTendered < subtotal) {
    // The UI blocks this; refuse here too so no path can record a short payment
    // as a fully paid sale.
    throw new Error(`Cash tendered is short by ${subtotal - input.amountTendered} tambala`)
  }
  const change =
    input.paymentMethod === 'cash' && input.amountTendered !== null
      ? Math.max(0, input.amountTendered - subtotal)
      : null

  const date = businessDate()
  // Read before the transaction opens: the label lives in settings, and a
  // Dexie transaction refuses any table it was not told about.
  const deviceId = getDeviceId()
  const tillLabel = await loadTillLabel()

  // The whole sale, including its receipt number, is produced inside the
  // transaction. Allocating the number beforehand let two commits racing read
  // the same row count and hand out the same receipt number.
  const sale = await db.transaction(
    'rw',
    [db.sales, db.saleLines, db.products, db.stockMovements, db.cashMovements, db.outbox],
    async () => {
      const receiptNo = await nextReceiptNo(date, deviceId, tillLabel)
      const created = withSyncMeta(undefined, {
        receiptNo,
        businessDate: date,
        subtotal,
        total: subtotal,
        paymentMethod: input.paymentMethod,
        amountTendered: input.paymentMethod === 'cash' ? input.amountTendered : null,
        change,
        status: 'completed' as const,
        voidedAt: null,
        note: input.note ?? '',
      }) as Sale

      await db.sales.put(created)
      await queueEntity('sales', created.id, 'upsert', created)

      // Cash goes into the drawer. The tendered amount and the change cancel
      // out, so the net gain is always the sale total.
      if (input.paymentMethod === 'cash') {
        const cash = withSyncMeta(undefined, {
          reason: 'sale' as const,
          delta: created.total,
          refId: created.id,
          businessDate: date,
          note: `Sale #${receiptNo}`,
        }) as CashMovement
        await db.cashMovements.put(cash)
        await queueEntity('cash_movements', cash.id, 'upsert', cash)
      }

      for (const line of input.lines) {
        let productId = line.productId

        // An ad-hoc line becomes a real product so the item is scannable next time.
        if (!productId) {
          const product = withSyncMeta(undefined, {
            barcode: normalizeBarcode(line.barcode),
            name: line.name,
            price: line.unitPrice,
            // Unknown cost: assume it sells at what it costs until the owner
            // edits it, rather than leaving a hole that reads as "M0 cost".
            cost: line.unitPrice,
            stockQty: 0,
            lowStockThreshold: 0,
            category: 'Uncategorised',
            active: true,
          }) as Product
          await db.products.put(product)
          await queueEntity('products', product.id, 'upsert', product)
          productId = product.id
        }

        const saleLine = withSyncMeta(undefined, {
          saleId: created.id,
          productId,
          barcode: line.barcode,
          name: line.name,
          unitPrice: line.unitPrice,
          qty: line.qty,
          lineTotal: line.unitPrice * line.qty,
          adHoc: line.adHoc,
        }) as SaleLine
        await db.saleLines.put(saleLine)
        await queueEntity('sale_lines', saleLine.id, 'upsert', saleLine)

        // Deduct stock for every line, including items already at zero or
        // negative. The shop allows overselling, so the ledger has to record
        // it — otherwise repairStockCache would silently disagree with sales.
        // Read the balance inside the transaction rather than trusting
        // `stockAtAdd`, which is only a snapshot taken at scan time.
        const current = await db.products.get(productId)
        const movement = withSyncMeta(undefined, {
          productId,
          delta: -line.qty,
          reason: 'sale' as const,
          refId: created.id,
          note: `Sale #${receiptNo}`,
        }) as StockMovement
        await db.stockMovements.put(movement)
        await queueEntity('stock_movements', movement.id, 'upsert', movement)
        await db.products.update(productId, {
          stockQty: (current?.stockQty ?? 0) - line.qty,
        })
      }

      return created
    },
  )

  return sale
}

/**
 * Void a sale.
 *
 * Nothing is deleted. The sale is flagged and reversing stock movements are
 * appended, so the ledger explains why a sale stopped counting.
 */
export async function voidSale(saleId: string, reason = ''): Promise<void> {
  await db.transaction(
    'rw',
    [db.sales, db.saleLines, db.products, db.stockMovements, db.cashMovements, db.outbox],
    async () => {
      const sale = await db.sales.get(saleId)
      if (!sale || sale.status === 'voided') return

      const lines = await db.saleLines.where('saleId').equals(saleId).toArray()

      for (const line of lines) {
        // Only reverse a movement we actually recorded at sale time.
        const original = await db.stockMovements
          .where('productId')
          .equals(line.productId)
          .filter((m) => m.refId === saleId && m.reason === 'sale')
          .first()
        if (!original) continue

        const reversal = withSyncMeta(undefined, {
          productId: line.productId,
          delta: -original.delta,
          reason: 'void' as const,
          refId: saleId,
          note: `Void sale #${sale.receiptNo}${reason ? `: ${reason}` : ''}`,
        }) as StockMovement
        await db.stockMovements.put(reversal)
        await queueEntity('stock_movements', reversal.id, 'upsert', reversal)

        // original.delta is negative, so subtracting it gives the stock back.
        const product = await db.products.get(line.productId)
        if (product) {
          await db.products.update(line.productId, {
            stockQty: product.stockQty - original.delta,
            updatedAt: Date.now(),
          })
        }
      }

      const updated = withSyncMeta(sale, {
        ...sale,
        status: 'voided' as const,
        voidedAt: Date.now(),
        note: reason ? `${sale.note}\nVoid: ${reason}`.trim() : sale.note,
      }) as Sale
      await db.sales.put(updated)
      await queueEntity('sales', saleId, 'upsert', updated)

      // Hand the cash back. Recorded against the sale's own day so that day's
      // net figure stays honest; the running drawer balance is unaffected.
      if (sale.paymentMethod === 'cash') {
        const cash = withSyncMeta(undefined, {
          reason: 'void' as const,
          delta: -sale.total,
          refId: saleId,
          businessDate: sale.businessDate,
          note: `Void sale #${sale.receiptNo}${reason ? `: ${reason}` : ''}`,
        }) as CashMovement
        await db.cashMovements.put(cash)
        await queueEntity('cash_movements', cash.id, 'upsert', cash)
      }
    },
  )
}

/** Manual stock correction. Always appends a movement, never edits history. */
export async function adjustStock(
  productId: string,
  newQty: number,
  note: string,
): Promise<void> {
  const product = await db.products.get(productId)
  if (!product) throw new Error('Product not found')
  const delta = newQty - product.stockQty
  if (delta === 0) return

  const movement = withSyncMeta(undefined, {
    productId,
    delta,
    reason: 'adjust' as const,
    refId: null,
    note,
  }) as StockMovement

  await db.transaction('rw', db.products, db.stockMovements, db.outbox, async () => {
    await db.stockMovements.put(movement)
    await queueEntity('stock_movements', movement.id, 'upsert', movement)
    await db.products.update(productId, { stockQty: newQty, updatedAt: Date.now() })
  })
}

export { getDeviceId }