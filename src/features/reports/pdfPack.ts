import { jsPDF } from 'jspdf'
import { buildBookPack, loadBooksData, periodLabel, type BookTable } from './books'
import { loadShopName } from '@/features/settings/shopName'
import { businessDate } from '@/features/sales/salesService'

/**
 * The books pack as a single PDF: sales, credit-sales, receipts, credit-receipts,
 * payments and bad-debt journals, trial balance, P&L, cash flow, balance sheet,
 * and inventory, each starting on its own page with the shop's name and the
 * period in the header. Drives straight to the phone's file app or share sheet —
 * no printer needed.
 */

const PAGE_W = 595.28 // A4 portrait, points
const PAGE_H = 841.89
const MARGIN = 40

export async function exportBooksPdf(dates: string[]): Promise<Blob> {
  const [data, shop] = await Promise.all([loadBooksData(), loadShopName()])
  const tables = buildBookPack(data, dates)
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const today = businessDate()

  // Cover header
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text(shop || 'The till', MARGIN, 64)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.text('Books and statements', MARGIN, 82)
  doc.setFontSize(10)
  doc.text(`Period: ${periodLabel(dates)}  ·  Prepared ${today}`, MARGIN, 98)
  doc.text('Recorded on the till — cash and customer credit.', MARGIN, 114)
  doc.setDrawColor(180)
  doc.line(MARGIN, 126, PAGE_W - MARGIN, 126)

  let first = true
  for (const table of tables) {
    if (!first) doc.addPage()
    first = false
    renderTable(doc, table)
  }

  // Page numbers
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 20, { align: 'right' })
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}

function renderTable(doc: jsPDF, table: BookTable): void {
  let y = 56

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(table.title, MARGIN, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(table.subtitle, MARGIN, y + 14)
  y += 30

  const cols = table.columns.length
  const width = PAGE_W - MARGIN * 2
  const colW = width / cols
  const alignRight = table.columns.map((c) => c.endsWith('(M)') || c === 'Qty')

  const drawHeader = () => {
    doc.setFillColor(241, 241, 241)
    doc.rect(MARGIN, y, width, 20, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    table.columns.forEach((c, i) => {
      const x = MARGIN + i * colW
      doc.text(c, x + 4, y + 13, { align: 'left' })
    })
    y += 20
  }
  drawHeader()

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  for (const row of table.rows) {
    if (y > PAGE_H - 60) {
      doc.addPage()
      y = 56
      drawHeader()
    }
    const isTotal = row[0] === 'TOTAL'
    if (row.length === 1) {
      // Section headings in statement tables: "ASSETS", "LIABILITIES"...
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.text(String(row[0]).toUpperCase(), MARGIN, y + 12)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      y += 20
      continue
    }
    if (row.length === 2 && alignRight[1]) {
      // Section headings with a label separate from the amount.
      if (row[1] === '') {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.text(String(row[0]).toUpperCase(), MARGIN, y + 12)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8.5)
        y += 18
        continue
      }
    }
    row.forEach((cell, i) => {
      const x = MARGIN + i * colW
      const text = truncate(String(cell), Math.max(4, Math.floor(colW / 4.6)))
      if (alignRight[i]) {
        doc.text(text, x + colW - 4, y + 12, { align: 'right' })
      } else {
        doc.text(text, x + 4, y + 12, { align: 'left' })
      }
    })
    if (isTotal && row.length > 2) {
      doc.setDrawColor(120)
      doc.line(MARGIN, y + 14.5, PAGE_W - MARGIN, y + 14.5)
    }
    y += 18
  }

  y += 6
  doc.setFontSize(8)
  doc.setTextColor(110)
  for (const note of table.notes) {
    doc.text(note, MARGIN, y)
    y += 12
  }
  doc.setTextColor(0)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}