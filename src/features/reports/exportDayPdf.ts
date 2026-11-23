import { db } from '@/db'
import { formatMaluti } from '@/domain/money'
import { localTime } from '@/domain/time'
import { loadShopName } from '@/features/settings/shopName'
import { tableToPdf } from './exportPdf'

/**
 * One day's takings as a compact, phone-friendly PDF.
 *
 * This is the report a shopkeeper actually reads on the phone, so it is one row
 * per sale rather than the seventeen-column line-level CSV an accountant uses.
 * The cashier, customer, item count, payment type and total are enough to check
 * the drawer against the till.
 */
export async function exportDaySalesPdf(date: string): Promise<Blob> {
  const [sales, shop] = await Promise.all([
    db.sales.where('businessDate').equals(date).toArray(),
    loadShopName().catch(() => ''),
  ])
  const saleIds = sales.map((sale) => sale.id)
  const lines = saleIds.length
    ? await db.saleLines.where('saleId').anyOf(saleIds).toArray()
    : []
  const itemsBySale = new Map<string, number>()
  for (const line of lines) {
    itemsBySale.set(line.saleId, (itemsBySale.get(line.saleId) ?? 0) + line.qty)
  }

  const sorted = [...sales].sort((a, b) => b.createdAt - a.createdAt)
  const rows = sorted.map((sale) => [
    sale.receiptNo,
    localTime(sale.createdAt),
    sale.cashierName ?? '',
    sale.customerName ?? '',
    String(itemsBySale.get(sale.id) ?? 0),
    sale.status === 'voided'
      ? 'Voided'
      : sale.paymentMethod === 'credit'
        ? 'Credit'
        : 'Cash',
    formatMaluti(sale.total, { symbol: false }),
  ])

  const completed = sales.filter((sale) => sale.status === 'completed')
  const voided = sales.filter((sale) => sale.status === 'voided')
  const cashSales = completed.filter((sale) => sale.paymentMethod === 'cash')
  const creditSales = completed.filter((sale) => sale.paymentMethod === 'credit')
  const total = (list: typeof sales) =>
    formatMaluti(list.reduce((sum, sale) => sum + sale.total, 0))

  const notes = [
    `Completed sales: ${completed.length}`,
    `Net total: M${total(completed)}`,
    `Cash sales: ${cashSales.length} · M${total(cashSales)}`,
    `Credit sales: ${creditSales.length} · M${total(creditSales)}`,
    `Voided: ${voided.length} · M${total(voided)}`,
    'Amounts are in Maluti (MWK). Credit sales are money the customer still owes.',
  ]

  return tableToPdf({
    title: `Sales — ${date}`,
    subtitle: shop || 'The till',
    columns: ['Receipt', 'Time', 'Cashier', 'Customer', 'Items', 'Payment', 'Total (MWK)'],
    rows,
    notes,
  })
}
