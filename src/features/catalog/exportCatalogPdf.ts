import { jsPDF } from 'jspdf'
import { formatMaluti } from '@/domain/money'

/**
 * Build a PDF of the full product catalog: barcode(s), name, details, category,
 * cost, selling price, profit per unit, stock qty, and totals.
 * Works entirely offline — jspdf is bundled in the app.
 *
 * The page is deliberately plain: white paper, black text, light rules. It is
 * meant to be printed or opened in any reader, not to match the app's dark UI.
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
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 12
  const tableWidth = pageWidth - margin * 2

  doc.setTextColor(0, 0, 0)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Product Catalog', margin, margin + 5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(70, 70, 70)
  doc.text(`Generated ${new Date().toLocaleDateString()}`, margin, margin + 12)

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
  const money = (cents: number) => formatMaluti(cents, { symbol: false })
  const rows = products.map((p) => {
    const cost = p.cost ?? p.price
    const unitProfit = p.price - cost
    const totalProfit = unitProfit * p.stockQty
    return [
      (p.barcodes ?? [p.barcode]).join('\n'),
      p.name,
      p.details ?? '',
      p.category,
      money(cost),
      money(p.price),
      money(unitProfit),
      String(p.stockQty),
      money(totalProfit),
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
    money(totalCost),
    money(totalRetail),
    '',
    String(totalQty),
    money(totalProfit),
  ]

  // Fractions of the available width. They must sum to 1 so no column runs off
  // the right edge of the page.
  const fractions = [0.14, 0.18, 0.16, 0.1, 0.09, 0.09, 0.09, 0.04, 0.11]
  const colWidths = fractions.map((f) => f * tableWidth)
  const colX = colWidths.map((_, i) =>
    colWidths.slice(0, i).reduce((sum, w) => sum + w, margin),
  )
  const alignRight = [false, false, false, false, true, true, true, true, true]
  const headerHeight = 8
  const bottomLimit = pageHeight - margin - 10

  let y = margin + 20

  const wrapCell = (text: string, maxWidth: number): string[] => {
    const out: string[] = []
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      if (words.length === 0) {
        out.push('')
        continue
      }
      let line = ''
      for (const word of words) {
        // A barcode or a long unbroken code can be wider than the column.
        // Break it into pieces rather than letting it run into the next column.
        let piece = word
        while (doc.getTextWidth(piece) > maxWidth && piece.length > 1) {
          let cut = piece.length
          while (cut > 1 && doc.getTextWidth(piece.slice(0, cut)) > maxWidth) cut--
          out.push(piece.slice(0, cut))
          piece = piece.slice(cut)
        }
        const candidate = line ? `${line} ${piece}` : piece
        if (!line || doc.getTextWidth(candidate) <= maxWidth) {
          line = candidate
        } else {
          out.push(line)
          line = piece
        }
      }
      out.push(line)
    }
    return out.length > 0 ? out : ['']
  }

  const drawHeader = () => {
    doc.setDrawColor(40, 40, 40)
    doc.line(margin, y, margin + tableWidth, y)
    doc.setTextColor(0, 0, 0)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    headers.forEach((header, i) => {
      const x = alignRight[i] ? colX[i]! + colWidths[i]! - 2 : colX[i]! + 2
      doc.text(header, x, y + 5.5, { align: alignRight[i] ? 'right' : 'left' })
    })
    doc.line(margin, y + headerHeight, margin + tableWidth, y + headerHeight)
    y += headerHeight
  }

  const drawRow = (row: string[], isTotal: boolean) => {
    doc.setFont('helvetica', isTotal ? 'bold' : 'normal')
    doc.setFontSize(7.5)
    const cellLines = row.map((cell, i) => wrapCell(String(cell), colWidths[i]! - 3))
    const lineCount = Math.max(1, ...cellLines.map((lines) => lines.length))
    const rowHeight = Math.max(6, lineCount * 3.4 + 2.4)

    if (y + rowHeight > bottomLimit) {
      doc.addPage()
      y = margin
      drawHeader()
      doc.setFont('helvetica', isTotal ? 'bold' : 'normal')
      doc.setFontSize(7.5)
    }

    if (isTotal) {
      doc.setDrawColor(40, 40, 40)
      doc.line(margin, y, margin + tableWidth, y)
    }

    doc.setTextColor(0, 0, 0)
    cellLines.forEach((lines, i) => {
      const x = alignRight[i] ? colX[i]! + colWidths[i]! - 2 : colX[i]! + 2
      lines.forEach((line, li) => {
        doc.text(line, x, y + 4 + li * 3.4, { align: alignRight[i] ? 'right' : 'left' })
      })
    })

    doc.setDrawColor(205, 205, 205)
    doc.line(margin, y + rowHeight, margin + tableWidth, y + rowHeight)
    y += rowHeight
  }

  drawHeader()
  rows.forEach((row) => drawRow(row, false))
  drawRow(totalsRow, true)

  // Footer on every page, after pagination is known.
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(70, 70, 70)
    doc.text(
      'Profit = selling price - cost. Total profit = profit x stock on hand.',
      margin,
      pageHeight - 7,
    )
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 7, {
      align: 'right',
    })
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}
