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
  /** Credit sale only: customer who owes the balance. */
  customerName?: string
  /** Credit sale only: cash handed over at the till. */
  amountPaidNow?: Cents
  note?: string
  /** Staff name for the sale. Defaults to "Owner" for legacy callers. */
  cashierName?: string
}

/**
 * Commit a sale.
 *
 * The sale, its lines, and the resulting stock movements are written in a single
 * transaction so the ledger can never end up with a sale that has no lines or a
 * stock change with no sale. Ad-hoc lines create a product first so stock and
 * reprints still work later.
 *
 * A credit sale bills the full total as revenue and leaves the customer owing
 * it. Any cash handed over at the till is a `credit_payment` movement, so the
 * drawer and the debt ledger agree from the first second.
 */
export async function commitSale(input: CommitInput): Promise<Sale> {
  if (input.lines.length === 0) throw new Error('Cart is empty')

  const subtotal = cartSubtotal(input.lines)
  const isCredit = input.paymentMethod === 'credit'
  const customerName = isCredit
    ? (input.customerName ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
    : ''
  if (isCredit && !customerName) {
    throw new Error('Enter the customer name for a credit sale.')
  }

  const paidNow = isCredit ? (input.amountPaidNow ?? 0) : 0
  if (paidNow < 0) throw new Error('Paid now cannot be negative.')
  if (paidNow > subtotal) {
    throw new Error('Paid now cannot be more than the sale total.')
  }

  if (!isCredit && input.amountTendered !== null && input.amountTendered < subtotal) {
    // The UI blocks this; refuse here too so no path can record a short payment
    // as a fully paid sale.
    throw new Error(`Cash tendered is short by ${subtotal - input.amountTendered} tambala`)
  }
  const change =
    !isCredit && input.amountTendered !== null
      ? Math.max(0, input.amountTendered - subtotal)
      : null

  const date = businessDate()
  // Read before the transaction opens: the label lives in settings, and a
  // Dexie transaction refuses any table it was not told about.
  const deviceId = getDeviceId()
  const tillLabel = await loadTillLabel()
  // Every new sale is attributed. Older callers (and the integration tests)
  // omit the field; they are the owner's sale by definition.
  const cashierName = input.cashierName?.trim().slice(0, 60) || 'Owner'

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
        amountTendered: isCredit ? null : input.amountTendered,
        change,
        status: 'completed' as const,
        voidedAt: null,
        note: input.note ?? '',
        cashierName,
        customerName: customerName || undefined,
      }) as Sale

      await db.sales.put(created)
      await queueEntity('sales', created.id, 'upsert', created)

      // Cash goes into the drawer. The tendered amount and the change cancel
      // out, so the net gain is always the sale total. On a credit sale only
      // the deposit goes in now; the rest is collected later.
      if (!isCredit) {
        const cash = withSyncMeta(undefined, {
          reason: 'sale' as const,
          delta: created.total,
          refId: created.id,
          businessDate: date,
          note: `Sale #${receiptNo}`,
          staffName: cashierName,
        }) as CashMovement
        await db.cashMovements.put(cash)
        await queueEntity('cash_movements', cash.id, 'upsert', cash)
      } else if (paidNow > 0) {
        const deposit = withSyncMeta(undefined, {
          reason: 'credit_payment' as const,
          delta: paidNow,
          refId: created.id,
          businessDate: date,
          note: `Deposit · ${customerName} · #${receiptNo}`,
          staffName: cashierName,
        }) as CashMovement
        await db.cashMovements.put(deposit)
        await queueEntity('cash_movements', deposit.id, 'upsert', deposit)
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
      if ((sale.writtenOffAmount ?? 0) > 0) {
        throw new Error('A written-off debt cannot be voided. Record a correcting sale instead.')
      }

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

      // Hand the cash back. A cash sale returns the whole total; a credit sale
      // returns only what the customer actually paid, because the unpaid part
      // was never in the drawer. Recorded against the sale's own day so that
      // day's net figure stays honest; the running drawer balance is unaffected.
      let refund = 0
      if (sale.paymentMethod === 'cash') {
        refund = sale.total
      } else {
        refund = (
          await db.cashMovements.where('refId').equals(saleId).toArray()
        )
          .filter((m) => m.reason === 'credit_payment')
          .reduce((sum, m) => sum + m.delta, 0)
      }
      if (refund > 0) {
        const cash = withSyncMeta(undefined, {
          reason: 'void' as const,
          delta: -refund,
          refId: saleId,
          businessDate: sale.businessDate,
          note: `Void sale #${sale.receiptNo}${reason ? `: ${reason}` : ''}`,
          staffName: sale.cashierName || undefined,
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