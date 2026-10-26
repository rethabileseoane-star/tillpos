import Papa from 'papaparse'
import { db } from '@/db'
import { summariseCash } from '@/features/cash/cashService'
import type { Product } from '@/db/types'

/**
 * CSV export for accountants.
 *
 * One row per sale line rather than per sale, which is the shape a spreadsheet
 * expects for a pivot table. Each line carries what it cost the shop (at the
 * recorded per-unit cost) next to what it sold for, so profit per line can be
 * pivoted. Voided sales are excluded and reported separately so totals here
 * always match the Z-report's net figure.
 */
export async function exportSalesCsv(dates?: string[]): Promise<Blob> {
  const [sales, products] = await Promise.all([
    dates?.length
      ? db.sales.where('businessDate').anyOf(dates).toArray()
      : db.sales.toArray(),
    db.products.toArray(),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))

  const completed = sales.filter((s) => s.status === 'completed')
  const saleIds = completed.map((s) => s.id)
  const lines = saleIds.length
    ? await db.saleLines.where('saleId').anyOf(saleIds).toArray()
    : []
  const saleMap = new Map(completed.map((s) => [s.id, s]))

  let cogs: number = 0
  const rows = lines
    .map((l) => {
      const sale = saleMap.get(l.saleId)
      if (!sale) return null
      // Cost unknown (a product that no longer exists): book at what it sold
      // for so the row shows zero profit instead of inventing a loss.
      const p: Product | undefined = byId.get(l.productId)
      const cost = p ? (p.cost ?? p.price) : l.unitPrice
      const lineCost = l.qty * cost
      cogs += lineCost
      return {
        date: sale.businessDate,
        receipt_no: sale.receiptNo,
        time: new Date(sale.createdAt).toISOString().slice(11, 19),
        cashier: sale.cashierName ?? '',
        barcode: l.barcode,
        item: l.name,
        qty: l.qty,
        unit_price_mwk: (l.unitPrice / 100).toFixed(2),
        unit_cost_mwk: (cost / 100).toFixed(2),
        line_total_mwk: (l.lineTotal / 100).toFixed(2),
        cost_mwk: (lineCost / 100).toFixed(2),
        profit_mwk: ((l.lineTotal - lineCost) / 100).toFixed(2),
        payment_method: sale.paymentMethod,
      }
    })
    .filter(Boolean)

  const header = Object.keys(rows[0] ?? {
    date: '', receipt_no: '', time: '', cashier: '', barcode: '', item: '',
    qty: '', unit_price_mwk: '', unit_cost_mwk: '', line_total_mwk: '',
    cost_mwk: '', profit_mwk: '', payment_method: '',
  })

  const voided = sales.filter((s) => s.status === 'voided')
  const csv = Papa.unparse(rows, { columns: header })
  const net = completed.reduce((s, x) => s + x.total, 0)

  // Drawer figures for the accountant. Balance is all-time; the rest is the
  // window being exported.
  const cash = summariseCash(await db.cashMovements.toArray(), dates)

  // A footer block keeps the void and cash figures in the same file rather than
  // silently dropping those sales from the books.
  const footer = [
    '',
    `# Completed sales: ${completed.length}`,
    `# Net total (MWK): ${net / 100}`,
    `# Cost of goods sold (MWK): ${cogs / 100}`,
    `# Gross profit (MWK): ${(net - cogs) / 100}`,
    `# Voided sales: ${voided.length}`,
    `# Voided total (MWK): ${voided.reduce((s, x) => s + x.total, 0) / 100}`,
    `# Opening float (MWK): ${cash.openingFloat / 100}`,
    `# Money in (MWK): ${cash.cashIn / 100}`,
    `# Bought stock (MWK): ${Math.abs(cash.purchases) / 100}`,
    `# Owner took (MWK): ${Math.abs(cash.drawings) / 100}`,
    `# Paid out (MWK): ${Math.abs(cash.expenses) / 100}`,
    `# Loan repayments (MWK): ${Math.abs(cash.loanRepay) / 100}`,
    `# Loans owed (MWK): ${cash.loans / 100}`,
    `# Cash in drawer (MWK): ${cash.balance / 100}`,
  ].join('\n')

  return new Blob([csv + footer], { type: 'text/csv;charset=utf-8' })
}