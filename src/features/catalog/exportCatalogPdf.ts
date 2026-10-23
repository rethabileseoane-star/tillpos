import { jsPDF } from 'jspdf'
import { formatMaluti } from '@/domain/money'

/**
 * Build a PDF of the full product catalog: barcode(s), name, details, category,
 * cost, selling price, profit per unit, stock qty, and totals.
 * Works entirely offline — jspdf is bundled in the app.
 */
export async function exportCatalogPdf(products: Array<{
  id: string
  barcode: string
  barcodes: string[]
  name: string
  details?: string
  price: number
  cost: number
  stockQty: number
  lowStockThreshold: number
  category: string
  active: boolean
}>): Promise<Blob> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 12
  const colWidth = pageWidth - margin * 2

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Product Catalog', margin, margin)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(120, 120, 130)
  doc.text(`Generated ${new Date().toLocaleDateString()}`, margin, margin + 7)

  const headers = [
    'Barcode(s)',
    'Name',
    'Details',
    'Category',
    'Cost (M)',
    'Price (M)',
    'Profit (M)',
    'Qty',
    'Total Profit (M)',
  ]
  const rows = products.map((p) => {
    const cost = p.cost ?? p.price
    const unitProfit = p.price - cost
    const totalProfit = unitProfit * p.stockQty
    return [
      (p.barcodes ?? [p.barcode]).join('\n'),
      p.name,
      p.details ?? '',
      p.category,
      formatMaluti(cost, { symbol: false }),
      formatMaluti(p.price, { symbol: false }),
      formatMaluti(unitProfit, { symbol: false }),
      String(p.stockQty),
      formatMaluti(totalProfit, { symbol: false }),
    ]
  })

  const totalCost = products.reduce((s, p) => s + (p.cost ?? p.price) * p.stockQty, 0)
  const totalRetail = products.reduce((s, p) => s + p.price * p.stockQty, 0)
  const totalQty = products.reduce((s, p) => s + p.stockQty, 0)
  const totalProfit = totalRetail - totalCost
  const totalsRow = [
    '',
    'TOTALS',
    '',
    '',
    formatMaluti(totalCost, { symbol: false }),
    formatMaluti(totalRetail, { symbol: false }),
    '',
    String(totalQty),
    formatMaluti(totalProfit, { symbol: false }),
  ]

  // Column widths tuned for A4 portrait (fractions of available width).
  const colWidths = [0.14, 0.20, 0.20, 0.11, 0.10, 0.10, 0.10, 0.05, 0.13].map(
    (f) => f * colWidth,
  )
  const rowHeight = 7
  const headerHeight = 8

  let y = margin + 16

  const drawHeader = () => {
    doc.setFillColor(15, 23, 42)
    doc.rect(margin, y, colWidth, headerHeight, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    let x = margin
    headers.forEach((h, i) => {
      doc.text(h, x + 2, y + 5.5)
      x += colWidths[i]
    })
    y += headerHeight
  }

  drawHeader()

  const drawRow = (row: string[], isTotal: boolean) => {
    if (y + rowHeight > 297 - margin) {
      doc.addPage()
      y = margin
      drawHeader()
    }

    const [fr, fg, fb] = isTotal ? [30, 58, 95] : [15, 23, 42]
    doc.setFillColor(fr, fg, fb)
    doc.rect(margin, y, colWidth, rowHeight, isTotal ? 'S' : 'F')
    doc.setTextColor(220, 220, 230)
    doc.setFont('helvetica', isTotal ? 'bold' : 'normal')
    doc.setFontSize(7.5)
    let x = margin
    row.forEach((cell, i) => {
      const lines = String(cell).split('\n')
      lines.forEach((line, li) => {
        doc.text(line, x + 2, y + 4.5 + li * 3.5)
      })
      x += colWidths[i]
    })
    y += rowHeight
  }

  rows.forEach((row) => drawRow(row, false))
  drawRow(totalsRow, true)

  doc.setTextColor(120, 120, 130)
  doc.setFontSize(7)
  doc.text(
    'Profit = selling price − cost. Total profit = profit × stock on hand.',
    margin,
    297 - margin + 4,
  )

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}
