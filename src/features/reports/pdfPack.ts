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

/** Explicit white paper and black ink, whatever the app theme is. */
function paintPage(doc: jsPDF): void {
  doc.setFillColor(255, 255, 255)
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F')
  doc.setTextColor(0, 0, 0)
}

export async function exportBooksPdf(dates: string[]): Promise<Blob> {
  const [data, shop] = await Promise.all([loadBooksData(), loadShopName()])
  const tables = buildBookPack(data, dates)
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const today = businessDate()

  // Cover header
  paintPage(doc)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text(shop || 'The till', MARGIN, 64)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.text('Books and statements', MARGIN, 82)
  doc.setFontSize(10)
  doc.text(`Period: ${periodLabel(dates)}  ·  Prepared ${today}`, MARGIN, 98)
  doc.text('Recorded on the till — cash and customer credit.', MARGIN, 114)
  doc.setDrawColor(0)
  doc.setLineWidth(0.8)
  doc.line(MARGIN, 126, PAGE_W - MARGIN, 126)

  // Every statement starts on its own page; the first one must not print over
  // the cover header.
  for (const table of tables) {
    doc.addPage()
    renderTable(doc, table)
  }

  // Page numbers
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(70, 70, 70)
    doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 20, { align: 'right' })
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}

function renderTable(doc: jsPDF, table: BookTable): void {
  let y = 56
  paintPage(doc)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(table.title, MARGIN, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(50, 50, 50)
  doc.text(table.subtitle, MARGIN, y + 14)
  doc.setTextColor(0, 0, 0)
  y += 30

  const cols = table.columns.length
  const width = PAGE_W - MARGIN * 2
  const colW = width / cols
  const alignRight = table.columns.map((c) => c.endsWith('(M)') || c === 'Qty')

  const drawHeader = () => {
    doc.setDrawColor(0)
    doc.setLineWidth(0.6)
    doc.line(MARGIN, y, MARGIN + width, y)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(0, 0, 0)
    table.columns.forEach((c, i) => {
      const x = MARGIN + i * colW
      doc.text(c, x + 4, y + 13, { align: 'left' })
    })
    doc.line(MARGIN, y + 20, MARGIN + width, y + 20)
    doc.setLineWidth(0.3)
    y += 20
  }
  drawHeader()

  for (const row of table.rows) {
    if (y > PAGE_H - 60) {
      doc.addPage()
      paintPage(doc)
      y = 56
      drawHeader()
    }

    const label = String(row[0])
    const isTotal =
      /^TOTAL\b/.test(label) ||
      /^NET\b/.test(label) ||
      /^GROSS\b/.test(label) ||
      label === 'LIABILITIES + EQUITY' ||
      label.startsWith('CASH IN THE DRAWER') ||
      row[1] === 'TOTAL'

    if (row.length === 1) {
      // Section headings in statement tables: "ASSETS", "LIABILITIES"...
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(0, 0, 0)
      doc.text(label.toUpperCase(), MARGIN, y + 12)
      y += 20
      continue
    }
    if (row.length === 2 && row[1] === '' && alignRight[1]) {
      // Section headings with a label separate from the amount.
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(0, 0, 0)
      doc.text(label.toUpperCase(), MARGIN, y + 12)
      y += 18
      continue
    }

    if (isTotal) {
      doc.setDrawColor(0)
      doc.setLineWidth(0.5)
      doc.line(MARGIN, y, MARGIN + width, y)
    }
    doc.setFont('helvetica', isTotal ? 'bold' : 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(0, 0, 0)
    row.forEach((cell, i) => {
      const x = MARGIN + i * colW
      const text = truncate(String(cell), Math.max(4, Math.floor(colW / 4.6)))
      if (alignRight[i]) {
        doc.text(text, x + colW - 4, y + 12, { align: 'right' })
      } else {
        doc.text(text, x + 4, y + 12, { align: 'left' })
      }
    })
    doc.setDrawColor(225)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, y + 15.5, MARGIN + width, y + 15.5)
    y += 18
  }

  y += 6
  if (y > PAGE_H - 40) {
    doc.addPage()
    paintPage(doc)
    y = 56
  }
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(60, 60, 60)
  for (const note of table.notes) {
    doc.text(note, MARGIN, y)
    y += 12
  }
  doc.setTextColor(0, 0, 0)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}